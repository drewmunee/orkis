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

// A JSON file that's loaded once and saved on every change (local fallback only)
function jsonFile(name) {
  const file = path.join(__dirname, 'data', name);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    data,
    save() { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); },
  };
}

// Players are identified by their browser ID when they have one (a random UUID their browser keeps), so
// changing username doesn't make them a new player. Without one, fall back to the username.
const BID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validBid = bid => typeof bid === 'string' && BID_RE.test(bid);
const playerKey = (bid, name) => validBid(bid) ? 'b:' + bid.toLowerCase() : 'name:' + String(name || '').trim().toLowerCase();

module.exports = { getPool, jsonFile, validBid, playerKey };
