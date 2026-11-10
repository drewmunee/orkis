// Solo leaderboards: best score per username. Stackwar counts lines cleared (this module's default
// export); Snakewar's classic solo mode counts food eaten (`.snake`). Each board is its own table/file.
// Uses Postgres when DATABASE_URL is set (needed on Render, whose disk is wiped on every restart);
// otherwise falls back to a JSON file for local play.
const fs = require('fs');
const path = require('path');

const TOP_N = 10;
const keyOf = name => name.trim().toLowerCase();

let pool = null; // one connection pool shared by every board
function postgresStore(url, table) {
  const { Pool } = require('pg');
  pool = pool || new Pool({ connectionString: url, max: 3 });
  const ready = pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
    name_key    text PRIMARY KEY,
    name        text NOT NULL,
    lines       integer NOT NULL,
    achieved_at timestamptz NOT NULL DEFAULT now()
  )`);
  return {
    kind: 'postgres',
    async submit(name, lines) {
      await ready;
      // keep only each name's best run
      await pool.query(
        `INSERT INTO ${table} (name_key, name, lines) VALUES ($1, $2, $3)
         ON CONFLICT (name_key) DO UPDATE SET name = EXCLUDED.name, lines = EXCLUDED.lines, achieved_at = now()
         WHERE ${table}.lines < EXCLUDED.lines`,
        [keyOf(name), name, lines]);
      const best = (await pool.query(`SELECT lines FROM ${table} WHERE name_key = $1`, [keyOf(name)])).rows[0].lines;
      const rank = +(await pool.query(`SELECT count(*) + 1 AS r FROM ${table} WHERE lines > $1`, [best])).rows[0].r; // rank of their best run
      return { best, rank };
    },
    async top() {
      await ready;
      const { rows } = await pool.query(`SELECT name, lines, achieved_at FROM ${table} ORDER BY lines DESC, achieved_at ASC LIMIT $1`, [TOP_N]);
      return rows.map(r => ({ name: r.name, lines: r.lines, at: r.achieved_at }));
    },
  };
}

function fileStore(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); };
  const sorted = () => Object.values(data).sort((a, b) => b.lines - a.lines || a.at.localeCompare(b.at));
  return {
    kind: 'file',
    async submit(name, lines) {
      const k = keyOf(name), cur = data[k];
      if (!cur || cur.lines < lines) { data[k] = { name, lines, at: new Date().toISOString() }; save(); }
      const best = data[k].lines;
      return { best, rank: Object.values(data).filter(e => e.lines > best).length + 1 };
    },
    async top() { return sorted().slice(0, TOP_N); },
  };
}

// The score column is called `lines` in both tables; for Snakewar it holds food eaten.
const board = (table, file) => process.env.DATABASE_URL
  ? postgresStore(process.env.DATABASE_URL, table)
  : fileStore(path.join(__dirname, 'data', file));

module.exports = board('leaderboard', 'leaderboard.json');
module.exports.snake = board('snake_leaderboard', 'snake-leaderboard.json');
