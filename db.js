// Shared storage connection. Postgres (Neon in production) when DATABASE_URL is set; otherwise callers
// fall back to small JSON files in data/ for local play and testing.
const fs = require('fs');
const path = require('path');

let pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  }
  return pool;
}

// Resolves once every migration in migrations.js has run (server.js waits for it before listening).
// Storage modules also await it before touching their tables.
let readyP = null;
function ready() {
  if (!readyP) readyP = getPool() ? require('./migrations').migrate(getPool()) : Promise.resolve([]);
  return readyP;
}

// Run several queries all-or-nothing: fn(client) gets a client inside BEGIN ... COMMIT.
async function transaction(fn) {
  await ready();
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function close() { if (pool) { const p = pool; pool = null; await p.end(); } }

// A JSON file that's loaded once and saved on every change (local fallback only)
function jsonFile(name) {
  const file = path.join(__dirname, 'data', name);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    data,
    // write to a temp file and rename, so a crash mid-save never leaves a half-written file
    save() { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1)); fs.renameSync(file + '.tmp', file); },
  };
}

// Players are identified by their browser ID when they have one (a random UUID their browser keeps), so
// changing username doesn't make them a new player. Without one, fall back to the username.
const BID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validBid = bid => typeof bid === 'string' && BID_RE.test(bid);
const playerKey = (bid, name) => validBid(bid) ? 'b:' + bid.toLowerCase() : 'name:' + String(name || '').trim().toLowerCase();

module.exports = { getPool, ready, transaction, close, jsonFile, validBid, playerKey };
