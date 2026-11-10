// Blockwar server: rooms, lobby, modes and relaying. Like Stackwar, each player's game runs in their own
// browser; the server starts matches, passes board snapshots and specials around, and decides winners.
//   solo  (1 player): endless; the client reports when it's over
//   clear (2+): everyone gets the same board; the first to clear every block wins
//   lives (2+): 3 lives each; the last player with lives left wins
const leaderboard = require('./leaderboard');
const moderation = require('./moderation');
const swearjar = require('./swearjar');
const MAX_PLAYERS = 6;
const MODES = ['clear', 'lives'];
const rooms = new Map();

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}
function freeSlot(room) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return 0;
}
function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, wins: p.wins }));
}
function sendLobby(room) {
  broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId, state: room.state, mode: room.mode });
}
const log = (room, msg) => broadcast(room, { t: 'log', msg });

function endMatch(room, winner, why) {
  room.state = 'lobby';
  if (winner && room.matchMode !== 'solo') winner.wins++;
  for (const p of room.players.values()) p.alive = false;
  broadcast(room, { t: 'gameover', winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : null, why });
  sendLobby(room);
}
function checkOver(room) {
  if (room.state !== 'playing') return;
  const alive = [...room.players.values()].filter(p => p.alive);
  if (room.matchMode === 'solo') { if (!alive.length) endMatch(room, null); return; }
  // clear races end when someone clears their board (handled on 'cleared'), or when only one is left
  if (alive.length <= 1) endMatch(room, alive[0] || null, room.matchMode === 'lives' ? 'last one with lives left' : 'last one standing');
}

// Solo runs go on the Blockwar leaderboard (best score per browser). The score comes from the player's
// browser, so reject anything impossible: no more than ~150 points a second over the whole run.
function recordSolo(room, p, score) {
  if (score < 1) return send(p.ws, { t: 'solo', score: 0 });
  const secs = (Date.now() - (room.startedAt || Date.now())) / 1000;
  if (score > Math.max(500, secs * 150)) { console.warn(`ignored implausible Blockwar score ${score} in ${secs.toFixed(0)} s from ${p.name}`); return send(p.ws, { t: 'solo', score, error: true }); }
  leaderboard.submit('blockwar', p, score).then(
    r => send(p.ws, { t: 'solo', score, ...r }),
    err => { console.error('blockwar leaderboard write failed:', err.message); send(p.ws, { t: 'solo', score, error: true }); });
}

function join(ws, id, m) {
  const code = String(m.room || 'lobby').trim().toLowerCase().slice(0, 20) || 'lobby';
  let room = rooms.get(code);
  if (!room) { room = { code, players: new Map(), hostId: id, state: 'lobby', mode: 'clear', matchMode: null }; rooms.set(code, room); }
  const slot = freeSlot(room);
  if (!slot) { send(ws, { t: 'error', msg: `Room is full (${MAX_PLAYERS} players max).` }); return null; }
  const me = { id, ws, slot, bid: typeof m.bid === 'string' ? m.bid.slice(0, 40) : null, name: String(m.name || 'Player').trim().slice(0, 14) || 'Player', alive: false, wins: 0, board: null };
  room.players.set(id, me);
  send(ws, { t: 'welcome', id, room: code });
  sendLobby(room);
  for (const p of room.players.values()) if (p.board && p.id !== id) send(ws, { t: 'board', id: p.id, ...p.board });
  log(room, `${me.name} joined`);

  return {
    message(m) {
      switch (m.t) {
        case 'start': {
          if (me.id !== room.hostId || room.state !== 'lobby') return;
          room.state = 'playing';
          room.matchMode = room.players.size === 1 ? 'solo' : room.mode;
          room.startedAt = Date.now();
          for (const p of room.players.values()) { p.alive = true; p.board = null; }
          // one seed for everyone so clear races start on identical boards
          broadcast(room, { t: 'start', seed: (Math.random() * 2 ** 31) | 0, mode: room.matchMode, players: playerList(room) });
          sendLobby(room);
          break;
        }
        case 'mode':
          if (me.id !== room.hostId || room.state !== 'lobby' || !MODES.includes(m.mode)) return;
          room.mode = m.mode; sendLobby(room);
          break;
        case 'board': {
          // periodic snapshot of a player's board for everyone else's side view
          if (typeof m.cells !== 'string' || m.cells.length > 400) return;
          const b = { cells: m.cells, px: +m.px || 0, pw: +m.pw || 0, balls: Array.isArray(m.balls) ? m.balls.slice(0, 16) : [], lives: m.lives | 0, left: m.left | 0, score: m.score | 0, level: m.level | 0 };
          me.board = b;
          broadcast(room, { t: 'board', id: me.id, ...b }, me.id);
          break;
        }
        case 'special': {
          if (!me.alive || room.state !== 'playing') return;
          const target = [...room.players.values()].find(p => p.slot === (m.slot | 0));
          if (!target || !target.alive) return;
          const type = String(m.special).slice(0, 1);
          send(target.ws, { t: 'special', special: type, from: me.id });
          broadcast(room, { t: 'used', special: type, from: me.id, to: target.id });
          break;
        }
        case 'cleared': // clear race: this player cleared their whole board
          if (!me.alive || room.state !== 'playing' || room.matchMode !== 'clear') return;
          log(room, `${me.name} cleared their board!`);
          endMatch(room, me, 'cleared their board first');
          break;
        case 'out': // lives mode / solo: this player is out of lives
          if (!me.alive || room.state !== 'playing') return;
          me.alive = false;
          broadcast(room, { t: 'dead', id: me.id });
          if (room.matchMode === 'solo') {
            log(room, `Game over: ${m.score | 0} points, level ${m.level | 0}`);
            recordSolo(room, me, m.score | 0);
          }
          else log(room, `${me.name} is out of lives`);
          checkOver(room);
          break;
        case 'chat':
          broadcast(room, { t: 'chat', id: me.id, msg: String(m.msg).slice(0, 200) });
          if (moderation.hasSwear(m.msg)) swearjar.addQuarter(me).then(line => log(room, line), e => console.error('swear jar failed:', e.message)); // a quarter in the jar
          break;
      }
    },
    close() {
      room.players.delete(me.id);
      if (!room.players.size) { rooms.delete(room.code); return; }
      if (room.hostId === me.id) room.hostId = room.players.values().next().value.id;
      if (me.alive) { me.alive = false; broadcast(room, { t: 'dead', id: me.id }); }
      log(room, `${me.name} left`);
      checkOver(room);
      sendLobby(room);
    },
  };
}

function lobbies() {
  return [...rooms.values()].map(r => ({ room: r.code, players: r.players.size, names: [...r.players.values()].map(p => p.name), playing: r.state !== 'lobby', mode: r.mode }));
}

module.exports = { join, lobbies, _rooms: rooms };
