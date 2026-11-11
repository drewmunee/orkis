// Every change to the database's structure lives here, as a numbered migration. Each one runs exactly
// once (recorded in schema_migrations), inside a transaction, before the server starts taking players.
//
// RULES (so a deploy never loses or duplicates anyone's data):
//  - Only ever ADD migrations to the end of the list, with the next id. Never edit, reorder or delete
//    one that has shipped: production has already run it and won't run it again.
//  - Prefer additive changes: new tables, new columns with a DEFAULT, new indexes.
//  - Never rename or drop a table/column that holds data, and never rename stored keys (game ids,
//    stat names, player_key formats). Add the new thing and read both instead.
//  - DROP TABLE/COLUMN/SCHEMA, TRUNCATE, and DELETE/UPDATE without a WHERE are refused unless the
//    migration says `destructive: true` (and the owner has agreed to it).
//  - Copying rows from one table to another must be safe to repeat (ON CONFLICT DO NOTHING / GREATEST).
//
// Before any new migration runs, every table is copied into a backup schema (backup_before_<id>);
// the newest BACKUPS_KEPT are kept. Two servers starting at once (Render runs old and new side by
// side during a deploy) are serialized by an advisory lock. If a migration fails, the server exits
// without starting, so Render keeps the previous version live and nothing is half-applied.

const MIGRATIONS = [
  {
    id: 1, name: 'base tables (leaderboard, settings, stats, swear jar) + one-time legacy leaderboard copy',
    async up(q) {
      await q(`CREATE TABLE IF NOT EXISTS scores (
        game text NOT NULL, player_key text NOT NULL, name text NOT NULL, score integer NOT NULL,
        achieved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (game, player_key))`);
      await q(`CREATE TABLE IF NOT EXISTS settings (
        bid text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS stats (
        player_key text NOT NULL, game text NOT NULL, stat text NOT NULL, value bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (player_key, game, stat))`);
      await q(`CREATE TABLE IF NOT EXISTS stat_players (
        player_key text PRIMARY KEY, name text NOT NULL,
        first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS swear_jar (
        player_key text PRIMARY KEY, name text NOT NULL, quarters bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now())`);
      // scores from the old per-username tables: copied once, then the old table is renamed (kept)
      for (const [table, game] of [['leaderboard', 'stackwar'], ['snake_leaderboard', 'snakewar']]) {
        if (!(await q('SELECT to_regclass($1) AS t', [table])).rows[0].t) continue;
        await q(`INSERT INTO scores (game, player_key, name, score, achieved_at)
          SELECT $1, 'name:' || name_key, name, lines, achieved_at FROM ${table} ON CONFLICT DO NOTHING`, [game]);
        await q(`ALTER TABLE ${table} RENAME TO ${table}_migrated`);
      }
      // username-keyed rows already merged into a browser's spot (same name, equal or better score)
      await q(`DELETE FROM scores s WHERE s.player_key LIKE 'name:%' AND EXISTS (
        SELECT 1 FROM scores b WHERE b.game = s.game AND b.player_key LIKE 'b:%' AND lower(b.name) = lower(s.name) AND b.score >= s.score)`);
    },
  },
  {
    id: 2, name: 'homepage chat + Stackwar daily run times',
    async up(q) {
      // the homepage's persistent chat (only the newest lines are kept; see homechat.js)
      await q(`CREATE TABLE IF NOT EXISTS home_chat (
        id bigserial PRIMARY KEY, player_key text NOT NULL, name text NOT NULL, msg text NOT NULL,
        at timestamptz NOT NULL DEFAULT now())`);
      // Stackwar daily 40-line run: each player's best time per (UTC) day
      await q(`CREATE TABLE IF NOT EXISTS daily_runs (
        day text NOT NULL, player_key text NOT NULL, name text NOT NULL, ms integer NOT NULL,
        achieved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (day, player_key))`);
    },
  },
  // { id: 3, name: '...', async up(q) { await q('ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... DEFAULT ...'); } },
];

const LOCK_ID = 7314021; // any constant; shared by every server instance
const BACKUPS_KEPT = 3;
const RISKY = [
  [/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i, 'DROP'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
  [/^\s*(DELETE|UPDATE)\b(?![\s\S]*\bWHERE\b)/i, 'DELETE/UPDATE without WHERE'],
];

function checkList(list) {
  list.forEach((m, i) => {
    if (m.id !== i + 1) throw new Error(`migration ids must be 1, 2, 3... in order (found ${m.id} at position ${i + 1})`);
    if (typeof m.up !== 'function' || !m.name) throw new Error(`migration ${m.id} needs a name and an up()`);
  });
}

// Copy every table in the public schema into backup_before_<id>, then prune old backups.
async function backup(c, id) {
  const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`)).rows.map(r => r.tablename);
  if (!tables.length) return null;
  const schema = `backup_before_${id}`;
  await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  for (const t of tables) {
    await c.query(`CREATE TABLE IF NOT EXISTS ${schema}."${t}" AS SELECT * FROM public."${t}"`);
  }
  const old = (await c.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^backup_before_[0-9]+$'`)).rows
    .map(r => r.nspname).sort((a, b) => +b.split('_').pop() - +a.split('_').pop()).slice(BACKUPS_KEPT);
  for (const s of old) await c.query(`DROP SCHEMA ${s} CASCADE`); // only ever our own backup copies
  return schema;
}

async function migrate(pool, list = MIGRATIONS) {
  checkList(list);
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map(r => r.id));
    const newest = Math.max(0, ...done);
    if (newest > list.length) console.warn(`database has migration ${newest} but this code only knows ${list.length} (older code running?)`);
    const todo = list.filter(m => !done.has(m.id));
    if (!todo.length) return [];
    const saved = await backup(c, todo[0].id);
    if (saved) console.log(`database backed up to schema ${saved}`);
    for (const m of todo) {
      const q = (sql, params) => {
        for (const [re, what] of RISKY) if (re.test(sql) && !m.destructive) throw new Error(`migration ${m.id} uses ${what}; mark it destructive: true only if that data loss is intended`);
        return c.query(sql, params);
      };
      await c.query('BEGIN');
      try {
        await m.up(q);
        await c.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
        await c.query('COMMIT');
        console.log(`database migration ${m.id} applied: ${m.name}`);
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw new Error(`database migration ${m.id} (${m.name}) failed and was rolled back: ${e.message}`);
      }
    }
    return todo.map(m => m.id);
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    c.release();
  }
}

module.exports = { migrate, MIGRATIONS };
