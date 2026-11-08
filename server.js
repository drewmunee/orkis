// Stackwar server: static files + WebSocket rooms.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MAX_PLAYERS = 6;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> room
let nextId = 1;

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, exceptId) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, msg);
}
function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, wins: p.wins }));
}
function sendLobby(room) {
  broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId, state: room.state });
}
function freeSlot(room) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return 0;
}
function checkGameOver(room) {
  if (room.state !== 'playing') return;
  const alive = [...room.players.values()].filter(p => p.alive);
  const over = room.startCount > 1 ? alive.length <= 1 : alive.length === 0;
  if (!over) return;
  room.state = 'lobby';
  const winner = room.startCount > 1 ? alive[0] : null;
  if (winner) winner.wins++;
  for (const p of room.players.values()) p.alive = false;
  broadcast(room, { t: 'gameover', winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : null });
  sendLobby(room);
}

wss.on('connection', ws => {
  const me = { id: nextId++, ws, name: '', slot: 0, alive: false, board: '', wins: 0 };
  let room = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      if (room) return;
      const code = String(m.room || 'lobby').trim().toLowerCase().slice(0, 20) || 'lobby';
      room = rooms.get(code);
      if (!room) { room = { code, players: new Map(), hostId: me.id, state: 'lobby', startCount: 0 }; rooms.set(code, room); }
      const slot = freeSlot(room);
      if (!slot) { send(ws, { t: 'error', msg: 'Room is full (6 players max).' }); room = null; return; }
      me.name = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
      me.slot = slot;
      room.players.set(me.id, me);
      send(ws, { t: 'welcome', id: me.id, room: code });
      sendLobby(room);
      // let a late joiner see current boards
      for (const p of room.players.values()) if (p.board && p.id !== me.id) send(ws, { t: 'board', id: p.id, cells: p.board });
      return;
    }
    if (!room) return;

    switch (m.t) {
      case 'start': {
        if (me.id !== room.hostId || room.state !== 'lobby') return;
        room.state = 'playing';
        room.startCount = room.players.size;
        const seed = (Math.random() * 2 ** 31) | 0;
        for (const p of room.players.values()) { p.alive = true; p.board = ''; }
        broadcast(room, { t: 'start', seed, players: playerList(room) });
        break;
      }
      case 'board':
        if (typeof m.cells !== 'string' || m.cells.length > 400) return;
        me.board = m.cells;
        broadcast(room, { t: 'board', id: me.id, cells: m.cells }, me.id);
        break;
      case 'lines': {
        // Multi-line clears send garbage rows to every other living player.
        if (!me.alive) return;
        const n = m.count | 0;
        const garbage = n >= 4 ? 4 : n === 3 ? 2 : n === 2 ? 1 : 0;
        if (!garbage) return;
        for (const p of room.players.values())
          if (p.id !== me.id && p.alive) send(p.ws, { t: 'garbage', count: garbage, from: me.id });
        broadcast(room, { t: 'log', msg: `${me.name} cleared ${n} lines → +${garbage} to all` });
        break;
      }
      case 'special': {
        if (!me.alive) return;
        const target = [...room.players.values()].find(p => p.slot === (m.slot | 0));
        if (!target || !target.alive) return;
        const type = String(m.special).slice(0, 1);
        if (type === 'S') {
          // swap boards: server holds the latest copy of each
          if (target.id !== me.id) {
            const a = me.board, b = target.board;
            send(me.ws, { t: 'setboard', cells: b });
            send(target.ws, { t: 'setboard', cells: a });
          }
        } else {
          send(target.ws, { t: 'special', special: type, from: me.id });
        }
        broadcast(room, { t: 'used', special: type, from: me.id, to: target.id });
        break;
      }
      case 'dead':
        if (!me.alive) return;
        me.alive = false;
        broadcast(room, { t: 'dead', id: me.id });
        checkGameOver(room);
        break;
      case 'chat':
        broadcast(room, { t: 'chat', id: me.id, msg: String(m.msg).slice(0, 200) });
        break;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.players.delete(me.id);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    if (room.hostId === me.id) room.hostId = room.players.values().next().value.id;
    if (me.alive) { me.alive = false; broadcast(room, { t: 'dead', id: me.id }); }
    broadcast(room, { t: 'log', msg: `${me.name} left` });
    checkGameOver(room);
    sendLobby(room);
  });
});

server.listen(PORT, () => console.log(`Stackwar running on http://localhost:${PORT}`));
