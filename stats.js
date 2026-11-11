// All-time player stats, per player (browser ID, or username without one) and per game.
// Games call add() for counters and best() for personal records; changes are buffered in memory and
// written to the database every few seconds, so a busy game never waits on storage.
const { getPool, ready, transaction, jsonFile, playerKey } = require('./db');

const FLUSH_MS = 5000;
const pending = new Map(); // "key|game|stat|op" -> number   (op: add | max)
const names = new Map();   // key -> latest name

function record(p, game, stat, n, op) {
  if (!p || !p.name || !n || p.bot) return; // bots (Snakewar) never get stats
  const key = playerKey(p.bid, p.name);
  names.set(key, p.name);
  const k = `${key}|${game}|${stat}|${op}`;
  pending.set(k, op === 'max' ? Math.max(pending.get(k) || 0, n) : (pending.get(k) || 0) + n);
}
// add(p, 'snakewar', 'kills') or add(p, 'stackwar', { lines: 4, tetrises: 1 })
function add(p, game, stats, n = 1) {
  if (typeof stats === 'string') return record(p, game, stats, n, 'add');
  for (const [s, v] of Object.entries(stats)) record(p, game, s, v, 'add');
}
// best(p, 'snakewar', 'longest', 57): keeps the highest value ever seen
const best = (p, game, stat, value) => record(p, game, stat, value, 'max');

// tables are created by migrations.js
function postgresStore(pool) {
  return {
    // one transaction: either the whole batch is saved or none of it is (then it's retried), so a
    // failed write can never count something twice or drop part of a batch
    write: (adds, maxes, who) => transaction(async pool => {
      const cols = rows => [rows.map(r => r[0]), rows.map(r => r[1]), rows.map(r => r[2]), rows.map(r => r[3])];
      if (adds.length) await pool.query(`INSERT INTO stats (player_key, game, stat, value) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])
        ON CONFLICT (player_key, game, stat) DO UPDATE SET value = stats.value + EXCLUDED.value`, cols(adds));
      if (maxes.length) await pool.query(`INSERT INTO stats (player_key, game, stat, value) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])
        ON CONFLICT (player_key, game, stat) DO UPDATE SET value = GREATEST(stats.value, EXCLUDED.value)`, cols(maxes));
      for (const [key, name] of who) await pool.query(`INSERT INTO stat_players (player_key, name) VALUES ($1, $2)
        ON CONFLICT (player_key) DO UPDATE SET name = EXCLUDED.name, last_seen = now()`, [key, name]);
    }),
    async read(key) {
      await ready();
      const rows = (await pool.query('SELECT game, stat, value FROM stats WHERE player_key = $1', [key])).rows;
      const who = (await pool.query('SELECT name, first_seen FROM stat_players WHERE player_key = $1', [key])).rows[0];
      return { rows: rows.map(r => [r.game, r.stat, +r.value]), name: who ? who.name : null, since: who ? who.first_seen : null };
    },
  };
}
function fileStore() {
  const f = jsonFile('stats.json');
  f.data.stats = f.data.stats || {}; f.data.players = f.data.players || {};
  return {
    async write(adds, maxes, who) {
      for (const [key, game, stat, v] of adds) { const g = ((f.data.stats[key] = f.data.stats[key] || {})[game] = f.data.stats[key][game] || {}); g[stat] = (g[stat] || 0) + v; }
      for (const [key, game, stat, v] of maxes) { const g = ((f.data.stats[key] = f.data.stats[key] || {})[game] = f.data.stats[key][game] || {}); g[stat] = Math.max(g[stat] || 0, v); }
      for (const [key, name] of who) f.data.players[key] = { name, since: (f.data.players[key] || {}).since || new Date().toISOString() };
      f.save();
    },
    async read(key) {
      const rows = []; for (const [game, g] of Object.entries(f.data.stats[key] || {})) for (const [stat, v] of Object.entries(g)) rows.push([game, stat, v]);
      const who = f.data.players[key]; return { rows, name: who ? who.name : null, since: who ? who.since : null };
    },
  };
}

const pool = getPool();
const store = pool ? postgresStore(pool) : fileStore();

let flushing = Promise.resolve();
function flush() {
  if (!pending.size && !names.size) return flushing;
  const adds = [], maxes = [];
  for (const [k, v] of pending) { const [key, game, stat, op] = k.split('|'); (op === 'max' ? maxes : adds).push([key, game, stat, v]); }
  const who = [...names]; pending.clear(); names.clear();
  flushing = flushing.then(() => store.write(adds, maxes, who)).catch(e => {
    // nothing was saved (the write is all-or-nothing): put it back so the next flush tries again
    console.error('stats write failed, will retry:', e.message);
    for (const [key, game, stat, v] of adds) { const k = `${key}|${game}|${stat}|add`; pending.set(k, (pending.get(k) || 0) + v); }
    for (const [key, game, stat, v] of maxes) { const k = `${key}|${game}|${stat}|max`; pending.set(k, Math.max(pending.get(k) || 0, v)); }
    for (const [key, name] of who) if (!names.has(key)) names.set(key, name);
  });
  return flushing;
}
const unsaved = () => pending.size + names.size;
setInterval(flush, FLUSH_MS).unref();

// Everything recorded for one browser: { name, since, games: { stackwar: { lines: 120, ... }, ... } }
async function forBrowser(bid, name) {
  await flush();
  const { rows, name: n, since } = await store.read(playerKey(bid, name));
  const games = {};
  for (const [game, stat, v] of rows) (games[game] = games[game] || {})[stat] = v;
  return { name: n, since, games };
}

module.exports = { add, best, flush, unsaved, forBrowser };
