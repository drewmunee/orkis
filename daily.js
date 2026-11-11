// Stackwar daily run: for each UTC day everyone plays the same seeded solo run and races to clear 40
// lines. Each player's best time per day is kept (one spot per browser ID, falling back to username);
// the homepage shows today's top 10, one entry per username like the other leaderboards.
const { getPool, transaction, ready, jsonFile, playerKey } = require('./db');

const GOAL = 40, TOP_N = 10;
const MIN_MS = 12000; // sanity check: nobody clears 40 lines in under 12 s

const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10); // "2026-11-11" (UTC)
const msUntilReset = (t = Date.now()) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t; };
// the day's seed: a simple string hash of the date, the same for everyone all day
function seedFor(day) { let h = 2166136261; for (const ch of 'stackwar-daily-' + day) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 2 ** 31; }

// tables are created by migrations.js
function postgresDaily(pool) {
  const topQuery = (day, limit) => pool.query(`SELECT name, ms, achieved_at FROM (
      SELECT DISTINCT ON (lower(name)) name, ms, achieved_at FROM daily_runs WHERE day = $1 ORDER BY lower(name), ms ASC, achieved_at ASC
    ) t ORDER BY ms ASC, achieved_at ASC LIMIT $2`, [day, limit]);
  return {
    submit: (day, key, name, ms) => transaction(async c => {
      const prev = (await c.query('SELECT ms FROM daily_runs WHERE day = $1 AND player_key = $2', [day, key])).rows[0];
      // keep the best (lowest) time; always show the latest name
      await c.query(`INSERT INTO daily_runs (day, player_key, name, ms) VALUES ($1, $2, $3, $4)
        ON CONFLICT (day, player_key) DO UPDATE SET name = EXCLUDED.name, ms = LEAST(daily_runs.ms, EXCLUDED.ms),
          achieved_at = CASE WHEN EXCLUDED.ms < daily_runs.ms THEN now() ELSE daily_runs.achieved_at END`, [day, key, name, ms]);
      const best = Math.min(ms, prev ? prev.ms : Infinity);
      const nameBest = Math.min(best, +((await c.query('SELECT MIN(ms) AS m FROM daily_runs WHERE day = $1 AND lower(name) = lower($2)', [day, name])).rows[0].m ?? best));
      const rank = +(await c.query(`SELECT count(*) + 1 AS r FROM (SELECT lower(name) AS n, MIN(ms) AS m FROM daily_runs WHERE day = $1 GROUP BY lower(name)) t
        WHERE t.n <> lower($2) AND t.m < $3`, [day, name, nameBest])).rows[0].r;
      return { best, prevBest: prev ? prev.ms : 0, rank, onBoard: rank <= TOP_N };
    }),
    async top(day) { await ready(); return (await topQuery(day, TOP_N)).rows.map(r => ({ name: r.name, ms: r.ms, at: r.achieved_at })); },
  };
}
function fileDaily() {
  const f = jsonFile('daily.json');
  const sorted = day => {
    const byName = new Map();
    for (const e of Object.values(f.data[day] || {})) { const k = e.name.toLowerCase(), cur = byName.get(k); if (!cur || e.ms < cur.ms) byName.set(k, e); }
    return [...byName.values()].sort((a, b) => a.ms - b.ms || a.at.localeCompare(b.at));
  };
  return {
    async submit(day, key, name, ms) {
      const board = f.data[day] = f.data[day] || {}, prev = board[key];
      board[key] = !prev || ms < prev.ms ? { name, ms, at: new Date().toISOString() } : { ...prev, name };
      f.save();
      const best = board[key].ms, list = sorted(day);
      const nameBest = Math.min(best, ...list.filter(e => e.name.toLowerCase() === name.toLowerCase()).map(e => e.ms));
      const rank = list.filter(e => e.name.toLowerCase() !== name.toLowerCase() && e.ms < nameBest).length + 1;
      return { best, prevBest: prev ? prev.ms : 0, rank, onBoard: rank <= TOP_N };
    },
    async top(day) { return sorted(day).slice(0, TOP_N); },
  };
}

const pool = getPool();
const store = pool ? postgresDaily(pool) : fileDaily();

module.exports = {
  GOAL, TOP_N, MIN_MS, today, msUntilReset, seedFor,
  submit: (day, p, ms) => store.submit(day, playerKey(p.bid, p.name), p.name, ms),
  top: day => store.top(day),
};
