// Checks that database migrations and saving never lose or duplicate data. Run it before shipping any
// change to storage (new tables/columns, new stats, new migrations):
//
//   TEST_DATABASE_URL=postgres://user:pass@localhost/scratchdb npm run test:db
//
// It WIPES the database it's given, so it only accepts a local one (never point it at production).
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_ || !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_)) {
  console.error('Set TEST_DATABASE_URL to a LOCAL scratch database (it gets wiped).');
  process.exit(2);
}
process.env.DATABASE_URL = URL_;
const ROOT = path.join(__dirname, '..');
const { migrate, MIGRATIONS } = require(path.join(ROOT, 'migrations'));
const BID = '11111111-1111-4111-8111-111111111111';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (msg) => { passed++; console.log('  ok -', msg); };

// every row of every public table, as one comparable value
async function snapshot(pool) {
  const out = {};
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map(r => r.tablename);
  for (const t of tables) {
    if (t === 'schema_migrations') continue;
    const rows = (await pool.query(`SELECT * FROM public."${t}"`)).rows.map(r => JSON.stringify(r)).sort();
    out[t] = rows;
  }
  return out;
}

(async () => {
  const pool = new Pool({ connectionString: URL_ });
  const q = (s, p) => pool.query(s, p);
  const stat = async (s) => +((await q(`SELECT value FROM stats WHERE player_key = $1 AND game = 'stackwar' AND stat = $2`, ['b:' + BID, s])).rows[0] || { value: 0 }).value;

  console.log('1. existing production-style data, no migration history yet');
  await q('DROP SCHEMA public CASCADE'); await q('CREATE SCHEMA public');
  for (const r of (await q(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'backup_before_%'`)).rows) await q(`DROP SCHEMA ${r.nspname} CASCADE`);
  await q(`CREATE TABLE leaderboard (name_key text PRIMARY KEY, name text, lines int, achieved_at timestamptz DEFAULT now())`);
  await q(`INSERT INTO leaderboard VALUES ('dg', 'DG', 50, now()), ('kim', 'Kim', 12, now())`);
  await q(`CREATE TABLE stats (player_key text NOT NULL, game text NOT NULL, stat text NOT NULL, value bigint NOT NULL DEFAULT 0, PRIMARY KEY (player_key, game, stat))`);
  await q(`INSERT INTO stats VALUES ($1, 'stackwar', 'lines', 500), ($1, 'stackwar', 'played', 40)`, ['b:' + BID]);
  const statsBefore = (await q('SELECT * FROM stats ORDER BY stat')).rows;

  console.log('2. three servers start at once (Render runs old and new side by side)');
  const pools = [0, 1, 2].map(() => new Pool({ connectionString: URL_ }));
  const results = await Promise.all(pools.map(p => migrate(p)));
  await Promise.all(pools.map(p => p.end()));
  assert.strictEqual(results.filter(r => r.length).length, 1); ok('only one of them applied the migrations');
  assert.deepStrictEqual((await q('SELECT id FROM schema_migrations ORDER BY id')).rows.map(r => r.id), MIGRATIONS.map(m => m.id)); ok('each migration recorded once');
  assert.deepStrictEqual((await q('SELECT * FROM stats ORDER BY stat')).rows, statsBefore); ok('existing stats untouched');
  assert.strictEqual((await q(`SELECT count(*) FROM scores WHERE game = 'stackwar'`)).rows[0].count, '2'); ok('legacy scores copied once');
  assert.strictEqual((await q(`SELECT to_regclass('leaderboard') AS t`)).rows[0].t, null); ok('legacy table renamed so it is never re-copied');
  assert.strictEqual((await q('SELECT count(*) FROM backup_before_1.stats')).rows[0].count, '2'); ok('backup schema made before migrating');

  console.log('3. the game modules write data');
  const stats = require(path.join(ROOT, 'stats'));
  const leaderboard = require(path.join(ROOT, 'leaderboard'));
  const swearjar = require(path.join(ROOT, 'swearjar'));
  const settings = require(path.join(ROOT, 'settings'));
  const p = { bid: BID, name: 'DG' };
  stats.add(p, 'stackwar', 'lines', 7); await stats.flush();
  assert.strictEqual(await stat('lines'), 507); ok('stats add onto existing totals');
  await leaderboard.submit('stackwar', p, 60);
  const top = await leaderboard.top('stackwar');
  assert.strictEqual(top.filter(e => e.name.toLowerCase() === 'dg').length, 1); ok('legacy DG merged into the browser spot, listed once');
  await swearjar.addQuarter(p); await settings.set(BID, { theme: 'dark' });

  console.log('4. restarting with no new migrations changes nothing');
  let before = await snapshot(pool);
  assert.deepStrictEqual(await migrate(pool), []);
  assert.deepStrictEqual(await snapshot(pool), before); ok('every table identical after restart');

  console.log('5. a new additive migration keeps all data');
  const add2 = { id: MIGRATIONS.length + 1, name: 'test: add a column', async up(qq) { await qq(`ALTER TABLE stat_players ADD COLUMN IF NOT EXISTS test_col integer NOT NULL DEFAULT 0`); } };
  assert.deepStrictEqual(await migrate(pool, [...MIGRATIONS, add2]), [add2.id]);
  const after = await snapshot(pool);
  for (const t of Object.keys(before)) assert.strictEqual(after[t].length, before[t].length, `row count changed in ${t}`);
  assert.deepStrictEqual(after.stats, before.stats); ok('row counts and stats unchanged');
  await q(`ALTER TABLE stat_players DROP COLUMN test_col`); await q('DELETE FROM schema_migrations WHERE id = $1', [add2.id]);

  console.log('6. dangerous and failing migrations are refused and rolled back');
  before = await snapshot(pool);
  const drop = { id: MIGRATIONS.length + 1, name: 'test: drop', async up(qq) { await qq('DROP TABLE stats'); } };
  await assert.rejects(migrate(pool, [...MIGRATIONS, drop]), /DROP/); ok('DROP TABLE refused without destructive: true');
  const wipe = { id: MIGRATIONS.length + 1, name: 'test: wipe', async up(qq) { await qq('DELETE FROM stats'); } };
  await assert.rejects(migrate(pool, [...MIGRATIONS, wipe]), /WHERE/); ok('DELETE without WHERE refused');
  const half = { id: MIGRATIONS.length + 1, name: 'test: half', async up(qq) { await qq(`UPDATE stats SET value = 0 WHERE stat = 'lines'`); await qq('SELECT nonsense FROM nowhere'); } };
  await assert.rejects(migrate(pool, [...MIGRATIONS, half]), /rolled back/);
  assert.deepStrictEqual(await snapshot(pool), before); ok('a migration that fails halfway leaves no changes');
  assert.strictEqual((await q('SELECT max(id) AS m FROM schema_migrations')).rows[0].m, MIGRATIONS.length); ok('failed migrations not recorded');
  const reorder = [{ ...MIGRATIONS[0], id: 2 }];
  await assert.rejects(migrate(pool, reorder), /in order/); ok('renumbered migrations refused');

  console.log('7. a failed stats write is retried, counted exactly once');
  await q('ALTER TABLE stats RENAME TO stats_offline');
  stats.add(p, 'stackwar', 'lines', 3); await stats.flush();
  assert.ok(stats.unsaved() > 0); ok('failed batch kept in memory');
  await q('ALTER TABLE stats_offline RENAME TO stats');
  await stats.flush(); await stats.flush();
  assert.strictEqual(await stat('lines'), 510); ok('retried batch saved once (507 + 3)');

  console.log('8. stats are saved when Render stops the server for a deploy');
  const port = 3900 + Math.floor(Math.random() * 50);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  for (let i = 0; i < 50 && !out.includes('running'); i++) await sleep(100);
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise(r => ws.on('open', r));
  const played = async () => +((await q(`SELECT value FROM stats WHERE player_key = $1 AND game = 'blockwar' AND stat = 'played'`, ['b:' + BID])).rows[0] || { value: 0 }).value;
  const playedBefore = await played();
  ws.send(JSON.stringify({ t: 'join', game: 'block', name: 'DG', bid: BID, room: 'dbtest' }));
  await sleep(200); ws.send(JSON.stringify({ t: 'start' })); await sleep(200);
  srv.kill('SIGTERM'); // well before the 5 s flush
  await new Promise(r => srv.on('exit', r));
  assert.strictEqual(await played(), playedBefore + 1, out); ok('buffered stats flushed on SIGTERM');

  await pool.end();
  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
