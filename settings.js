// Per-player settings, saved against the browser ID (theme today; controls and other preferences later).
// Stored as one small JSON object per browser.
const { getPool, ready, jsonFile, validBid } = require('./db');

const MAX_BYTES = 4096;

function postgresSettings(pool) {
  return {
    async get(bid) { await ready(); const r = (await pool.query('SELECT data FROM settings WHERE bid = $1', [bid])).rows[0]; return r ? r.data : {}; },
    async set(bid, data) {
      await ready();
      await pool.query(`INSERT INTO settings (bid, data) VALUES ($1, $2)
        ON CONFLICT (bid) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [bid, data]);
    },
  };
}
function fileSettings() {
  const f = jsonFile('settings.json');
  return {
    async get(bid) { return f.data[bid] || {}; },
    async set(bid, data) { f.data[bid] = data; f.save(); },
  };
}

const pool = getPool();
const store = pool ? postgresSettings(pool) : fileSettings();

module.exports = {
  MAX_BYTES,
  async get(bid) { if (!validBid(bid)) throw new Error('bad id'); return store.get(bid.toLowerCase()); },
  async set(bid, data) {
    if (!validBid(bid)) throw new Error('bad id');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('settings must be an object');
    if (JSON.stringify(data).length > MAX_BYTES) throw new Error('settings too large');
    return store.set(bid.toLowerCase(), data);
  },
};
