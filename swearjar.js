// The swear jar: every chat message with a swear word in it puts a quarter in. Kept permanently, per
// player (browser ID, or username without one) so the total can be broken down later.
const { getPool, jsonFile, playerKey } = require('./db');

function postgresJar(pool) {
  const ready = pool.query(`CREATE TABLE IF NOT EXISTS swear_jar (
    player_key text PRIMARY KEY,
    name       text NOT NULL,
    quarters   bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  return {
    async add(key, name) {
      await ready;
      await pool.query(`INSERT INTO swear_jar (player_key, name, quarters) VALUES ($1, $2, 1)
        ON CONFLICT (player_key) DO UPDATE SET quarters = swear_jar.quarters + 1, name = EXCLUDED.name, updated_at = now()`, [key, name]);
      return +(await pool.query('SELECT COALESCE(SUM(quarters), 0) AS q FROM swear_jar')).rows[0].q;
    },
    async total() { await ready; return +(await pool.query('SELECT COALESCE(SUM(quarters), 0) AS q FROM swear_jar')).rows[0].q; },
  };
}
function fileJar() {
  const f = jsonFile('swearjar.json');
  const sum = () => Object.values(f.data).reduce((n, e) => n + e.quarters, 0);
  return {
    async add(key, name) { const e = f.data[key] || { name, quarters: 0 }; e.quarters++; e.name = name; f.data[key] = e; f.save(); return sum(); },
    async total() { return sum(); },
  };
}

const pool = getPool();
const jar = pool ? postgresJar(pool) : fileJar();
const dollars = q => '$' + (q / 4).toFixed(2);

// Add a quarter for this player; resolves to the line to show in chat.
async function addQuarter(p) {
  const total = await jar.add(playerKey(p.bid, p.name), p.name);
  return `${p.name} puts a quarter into the swear jar. The swear jar is at ${dollars(total)}.`;
}

module.exports = { addQuarter, total: () => jar.total(), dollars };
