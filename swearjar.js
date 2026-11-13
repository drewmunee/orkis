// The swear jar: every chat message with a swear word in it puts a quarter in. Kept permanently, per
// player (browser ID, or username without one) so the total can be broken down later.
const { getPool, ready, jsonFile, playerKey } = require('./db');

function postgresJar(pool) {
  return {
    async add(key, name) {
      await ready();
      await pool.query(`INSERT INTO swear_jar (player_key, name, quarters) VALUES ($1, $2, 1)
        ON CONFLICT (player_key) DO UPDATE SET quarters = swear_jar.quarters + 1, name = EXCLUDED.name, updated_at = now()`, [key, name]);
      return +(await pool.query('SELECT COALESCE(SUM(quarters), 0) AS q FROM swear_jar')).rows[0].q;
    },
    async total() { await ready(); return +(await pool.query('SELECT COALESCE(SUM(quarters), 0) AS q FROM swear_jar')).rows[0].q; },
    async mine(key) { await ready(); const r = (await pool.query('SELECT quarters FROM swear_jar WHERE player_key = $1', [key])).rows[0]; return r ? +r.quarters : 0; },
  };
}
function fileJar() {
  const f = jsonFile('swearjar.json');
  const sum = () => Object.values(f.data).reduce((n, e) => n + e.quarters, 0);
  return {
    async add(key, name) { const e = f.data[key] || { name, quarters: 0 }; e.quarters++; e.name = name; f.data[key] = e; f.save(); return sum(); },
    async total() { return sum(); },
    async mine(key) { return (f.data[key] || {}).quarters || 0; },
  };
}

const pool = getPool();
const jar = pool ? postgresJar(pool) : fileJar();
const dollars = q => '$' + (q / 4).toFixed(2);

// Add a quarter for this player; resolves to the line to show in chat.
// Every swear always goes in the jar, but the chat line only appears on a player's 1st quarter and then
// every ANNOUNCE_EVERY-th one after (1st, 4th, 7th ...), so it doesn't flood the chat. Resolves to the line to
// show, or null when this quarter goes in quietly.
const ANNOUNCE_EVERY = 3;
async function addQuarter(p) {
  const key = playerKey(p.bid, p.name);
  const total = await jar.add(key, p.name);
  const mine = await jar.mine(key);
  if ((mine - 1) % ANNOUNCE_EVERY !== 0) return null;
  return `${p.name} puts a quarter into the swear jar. The swear jar is at ${dollars(total)}.`;
}

module.exports = { addQuarter, total: () => jar.total(), mine: (bid, name) => jar.mine(playerKey(bid, name)), dollars };
