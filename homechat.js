// The homepage chat: one site-wide room that keeps its newest KEEP lines, so anyone opening the site sees
// what people have been saying recently. Browsers poll GET /api/chat?after=<id> and send with POST.
// Swear words still put a quarter in the swear jar; that line is saved into the chat like a message.
const { getPool, ready, jsonFile, playerKey, validBid } = require('./db');
const moderation = require('./moderation');
const swearjar = require('./swearjar');

const KEEP = 50, MAX_LEN = 200, MIN_GAP_MS = 1000;

// tables are created by migrations.js
function postgresChat(pool) {
  return {
    async add(key, name, msg) {
      await ready();
      const id = (await pool.query('INSERT INTO home_chat (player_key, name, msg) VALUES ($1, $2, $3) RETURNING id', [key, name, msg])).rows[0].id;
      // only the newest KEEP lines are kept
      await pool.query('DELETE FROM home_chat WHERE id <= $1', [+id - KEEP]);
    },
    async since(after) {
      await ready();
      const rows = (await pool.query(`SELECT id, name, msg, at FROM (SELECT * FROM home_chat WHERE id > $1 ORDER BY id DESC LIMIT $2) t ORDER BY id`, [after, KEEP])).rows;
      return rows.map(r => ({ id: +r.id, name: r.name, msg: r.msg, at: r.at }));
    },
  };
}
function fileChat() {
  const f = jsonFile('homechat.json');
  f.data.lines = f.data.lines || []; f.data.next = f.data.next || 1;
  return {
    async add(key, name, msg) {
      f.data.lines.push({ id: f.data.next++, name, msg, at: new Date().toISOString() });
      f.data.lines = f.data.lines.slice(-KEEP); f.save();
    },
    async since(after) { return f.data.lines.filter(l => l.id > after); },
  };
}

const pool = getPool();
const store = pool ? postgresChat(pool) : fileChat();
const lastSent = new Map(); // player key -> time of their last message (simple flood guard)

// since(afterId) -> the newest lines after that id (at most KEEP), oldest first
const since = after => store.since(Math.max(0, +after || 0));

// post({ bid, name, msg }) -> resolves, or throws an Error whose message can be shown to the player
async function post({ bid, name, msg }) {
  name = String(name || '').trim().slice(0, 14);
  msg = String(msg || '').trim().slice(0, MAX_LEN);
  if (!name) throw new Error('Enter a username first.');
  if (!moderation.nameAllowed(name)) throw new Error(moderation.NAME_REFUSED);
  if (!msg) throw new Error('Type a message first.');
  if (msg.startsWith('/')) throw new Error('Chat commands work inside game lobbies.');
  const p = { bid: validBid(bid) ? bid : null, name }, key = playerKey(p.bid, name);
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < MIN_GAP_MS) throw new Error('Slow down a little.');
  lastSent.set(key, now);
  if (lastSent.size > 5000) lastSent.clear();
  await store.add(key, name, msg);
  if (moderation.hasSwear(msg)) {
    const line = await swearjar.addQuarter(p);
    await store.add('system', '', line); // shown as an event line (no name)
  }
}

module.exports = { since, post, KEEP };
