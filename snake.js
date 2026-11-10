// Snakewar: battle-royale snake. The server owns the game: it moves every snake on a fixed tick,
// resolves collisions and food, and broadcasts the whole field to everyone in the room.
const leaderboard = require('./leaderboard').snake;
const GW = 112, GH = 63;           // full-size 16:9 field, fills most laptop/desktop screens
// Field size depends on how many are in the room when a round starts: solo is classic snake on a small
// 32x18 board; 2 players get a quarter of the full area, 3 players half, 4+ the full field. All 16:9.
const CLASSIC = { w: 32, h: 18 };
function fieldFor(n) {
  if (n <= 1) return { ...CLASSIC };
  const k = n === 2 ? 0.5 : n === 3 ? Math.SQRT1_2 : 1; // side scale: area 1/4, 1/2, full
  return { w: Math.round(GW * k), h: Math.round(GH * k) };
}
const FOOD_GROWTH = 2;              // every food (incl. what dead snakes leave) adds 2 segments
// Food on the field: one per player at the start, rising steadily as the round goes on
// (x2 after 1 minute, x3 after 2 ...), capped at FOOD_MAX_MULT x the start and FOOD_CAP overall.
const FOOD_RAMP_MS = 60000, FOOD_MAX_MULT = 5, FOOD_CAP = 100;
const TICK_MS = 110;               // one step per tick (two while Speed is active)
const COUNTDOWN_MS = 3000;
const MAX_PLAYERS = 12;
const START_LEN = 4;
const SPECIAL_LIFETIME = 15000;    // uneaten special foods vanish after this
const MAX_SPECIALS = 3;
const SPECIAL_CHANCE = 1 / 70;     // per tick, while below MAX_SPECIALS (~ one every 8s)
// Special foods (value = effect duration in ms): speed (2 steps per tick), ghost (pass through snake bodies),
// feast (+5 length), shears (every other snake loses SHEARS_CUT segments, never below SHEARS_MIN),
// double (all growth x2), slow (every other snake moves at half speed)
const SPECIALS = { speed: 5000, ghost: 6000, feast: 0, shears: 0, double: 20000, slow: 5000 };
const SHEARS_CUT = 4, SHEARS_MIN = 3;
const SPECIAL_KEYS = Object.keys(SPECIALS);
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

const rooms = new Map();
const cell = (r, x, y) => y * r.w + x;           // cells are numbered per room, since field sizes differ
const xy = (r, c) => [c % r.w, (c / r.w) | 0];
const rnd = n => (Math.random() * n) | 0;

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function freeSlot(room) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return 0;
}
function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, wins: p.wins, len: p.body.length }));
}
function sendLobby(room) { broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId, state: room.state }); }
function log(room, msg) { broadcast(room, { t: 'log', msg }); }

function occupied(room) {
  const occ = new Set();
  for (const p of room.players.values()) if (p.alive) for (const c of p.body) occ.add(c);
  return occ;
}
function randomFreeCell(room, occ = occupied(room)) {
  for (let i = 0; i < 500; i++) {
    const c = cell(room, rnd(room.w), rnd(room.h));
    if (!occ.has(c) && !room.food.has(c) && !room.drops.has(c) && !room.specials.has(c)) return c;
  }
  return -1;
}
function spawnSnake(room, p, occ) {
  // find a spot with room to move, pointing toward the middle of the field
  for (let tries = 0; tries < 300; tries++) {
    const W = room.w, H = room.h, mx = Math.min(8, W >> 2), my = Math.min(6, H >> 2);
    const x = mx + rnd(W - 2 * mx), y = my + rnd(H - 2 * my);
    const dir = Math.abs(x - W / 2) > Math.abs(y - H / 2) ? (x < W / 2 ? 'R' : 'L') : (y < H / 2 ? 'D' : 'U');
    const [dx, dy] = DIRS[dir];
    const body = [];
    for (let i = 0; i < START_LEN; i++) body.push(cell(room, x - dx * i, y - dy * i));
    // keep a clear zone around the new snake
    let clear = true;
    for (const c of body) { const [cx, cy] = xy(room, c); for (let ox = -3; ox <= 3 && clear; ox++) for (let oy = -3; oy <= 3; oy++) if (occ.has(cell(room, cx + ox, cy + oy))) { clear = false; break; } }
    if (!clear) continue;
    p.body = body; p.dir = dir; p.queue = []; p.grow = 0; p.fx = {}; p.alive = true; p.eaten = 0;
    for (const c of body) occ.add(c);
    return;
  }
  p.alive = false;
}

function startRound(room) {
  room.state = 'countdown';
  room.food = new Set(); room.drops = new Set(); room.specials = new Map();
  room.startCount = room.players.size;
  // Solo rounds are classic snake: walls kill, one food at a time, +1 per food, no special foods,
  // and the score (food eaten) goes on the Snakewar high-score board.
  room.classic = room.startCount === 1;
  Object.assign(room, fieldFor(room.startCount));
  room.tickN = 0; room.playStart = Date.now() + COUNTDOWN_MS;
  const occ = new Set();
  for (const p of room.players.values()) spawnSnake(room, p, occ);
  topUpFood(room);
  broadcast(room, { t: 'start', countdown: COUNTDOWN_MS, players: playerList(room) });
  sendState(room);
  sendLobby(room);
  room.timer = setTimeout(() => {
    room.state = 'playing';
    room.timer = setInterval(() => tick(room), TICK_MS);
  }, COUNTDOWN_MS);
}
function stopRound(room) { clearTimeout(room.timer); clearInterval(room.timer); room.timer = null; }

function topUpFood(room) {
  if (room.classic) { if (!room.food.size) { const c = randomFreeCell(room); if (c >= 0) room.food.add(c); } return; }
  const base = Math.max(1, room.startCount || room.players.size);
  const mult = Math.min(FOOD_MAX_MULT, 1 + Math.max(0, Date.now() - (room.playStart || Date.now())) / FOOD_RAMP_MS);
  const want = Math.min(FOOD_CAP, Math.floor(base * mult));
  const occ = occupied(room);
  while (room.food.size < want) { const c = randomFreeCell(room, occ); if (c < 0) break; room.food.add(c); }
}

function kill(room, p, why) {
  p.alive = false;
  // a dead snake breaks into food: every other segment is left behind
  p.body.forEach((c, i) => { if (i % 2 === 0) room.drops.add(c); });
  log(room, `${p.name} ${why}`);
}

function step(room, movers) {
  const occ = new Map(); // cell -> count of snake segments occupying it after tails move
  for (const p of room.players.values()) if (p.alive) {
    const keepTail = !movers.includes(p) || p.grow > 0;
    p.body.forEach((c, i) => { if (i < p.body.length - 1 || keepTail) occ.set(c, (occ.get(c) || 0) + 1); });
  }
  const heads = new Map(); // new head cell -> snakes moving there
  const plan = [];
  for (const p of movers) {
    if (p.queue.length) { const d = p.queue.shift(); if (!isReverse(p.dir, d)) p.dir = d; }
    const [hx, hy] = xy(room, p.body[0]), [dx, dy] = DIRS[p.dir];
    const nx = hx + dx, ny = hy + dy;
    if (room.classic && (nx < 0 || ny < 0 || nx >= room.w || ny >= room.h)) { plan.push([p, -1]); continue; } // classic: walls kill
    // battle rounds wrap: leaving one edge brings you in on the opposite side
    const nc = cell(room, (nx + room.w) % room.w, (ny + room.h) % room.h);
    plan.push([p, nc]);
    heads.set(nc, (heads.get(nc) || []).concat(p));
  }
  const dead = [];
  for (const [p, nc] of plan) {
    const ghost = p.fx.ghost > Date.now();
    if (nc < 0) { dead.push([p, 'hit the wall']); continue; }
    if (!ghost && occ.has(nc)) {
      const owner = [...room.players.values()].find(q => q.alive && q.body.includes(nc));
      dead.push([p, owner === p ? 'ran into themselves' : `crashed into ${owner ? owner.name : 'a snake'}`]); continue;
    }
    const rivals = heads.get(nc).filter(q => q !== p && !(q.fx.ghost > Date.now()));
    if (!ghost && rivals.length) { dead.push([p, `collided head-on with ${rivals[0].name}`]); continue; }
  }
  const deadSet = new Set(dead.map(d => d[0]));
  for (const [p, nc] of plan) {
    if (deadSet.has(p)) continue;
    p.body.unshift(nc);
    if (p.grow > 0) p.grow--; else p.body.pop();
    const x2 = p.fx.double > Date.now() ? 2 : 1; // Double: all growth counts twice
    if (room.food.has(nc)) { room.food.delete(nc); p.eaten++; p.grow += room.classic ? 1 : FOOD_GROWTH * x2; }
    else if (room.drops.has(nc)) { room.drops.delete(nc); p.grow += FOOD_GROWTH * x2; }
    const sp = room.specials.get(nc);
    if (sp) {
      room.specials.delete(nc);
      if (sp.type === 'feast') p.grow += 5 * x2;
      else if (sp.type === 'shears') {
        for (const q of room.players.values()) if (q !== p && q.alive) { q.body.splice(Math.max(SHEARS_MIN, q.body.length - SHEARS_CUT)); q.grow = 0; }
        log(room, `${p.name} grabbed Shears: everyone else loses ${SHEARS_CUT}`);
      }
      else if (sp.type === 'slow') {
        for (const q of room.players.values()) if (q !== p && q.alive) q.fx.slow = Date.now() + SPECIALS.slow;
        log(room, `${p.name} grabbed Slow: everyone else is slowed`);
      }
      else p.fx[sp.type] = Date.now() + SPECIALS[sp.type];
      broadcast(room, { t: 'ate', id: p.id, special: sp.type });
    }
  }
  for (const [p, why] of dead) kill(room, p, why);
}
const isReverse = (a, b) => DIRS[a][0] === -DIRS[b][0] && DIRS[a][1] === -DIRS[b][1];

function tick(room) {
  const alive = () => [...room.players.values()].filter(p => p.alive);
  const now0 = Date.now(), odd = room.tickN++ % 2 === 1;
  const slowed = p => p.fx.slow > now0;
  step(room, alive().filter(p => !(slowed(p) && odd)));      // slowed snakes skip every other tick
  const fast = alive().filter(p => p.fx.speed > Date.now() && !slowed(p));
  if (fast.length) step(room, fast);
  // special foods come and go
  const now = Date.now();
  for (const [c, sp] of room.specials) if (sp.until < now) room.specials.delete(c);
  if (!room.classic && room.specials.size < MAX_SPECIALS && Math.random() < SPECIAL_CHANCE) {
    const c = randomFreeCell(room);
    if (c >= 0) room.specials.set(c, { type: SPECIAL_KEYS[rnd(SPECIAL_KEYS.length)], until: now + SPECIAL_LIFETIME });
  }
  topUpFood(room);
  sendState(room);
  checkRoundOver(room);
}

function sendState(room) {
  const now = Date.now();
  broadcast(room, {
    t: 'state', w: room.w, h: room.h, classic: !!room.classic,
    snakes: [...room.players.values()].filter(p => p.alive).map(p => ({
      id: p.id, body: p.body, dir: p.dir, eaten: p.eaten || 0,
      fx: Object.fromEntries(Object.entries(p.fx).filter(([, u]) => u > now).map(([k, u]) => [k, u - now])),
    })),
    food: [...room.food], drops: [...room.drops],
    specials: [...room.specials].map(([c, sp]) => [c, sp.type, sp.until - now]),
  });
}

// Classic solo: save the score (food eaten) and tell the player how it compares to their best.
function recordClassic(room, p = [...room.players.values()][0]) {
  if (!p) return;
  const score = p.eaten || 0;
  if (!score) return send(p.ws, { t: 'classic', score: 0 });
  leaderboard.submit(p.name, score).then(
    ({ best, rank }) => send(p.ws, { t: 'classic', score, best, rank }),
    err => { console.error('snake leaderboard write failed:', err.message); send(p.ws, { t: 'classic', score, error: true }); });
}
function checkRoundOver(room) {
  if (room.state !== 'playing' && room.state !== 'countdown') return;
  const alive = [...room.players.values()].filter(p => p.alive);
  const over = room.startCount > 1 ? alive.length <= 1 : alive.length === 0;
  if (!over) return;
  stopRound(room);
  room.state = 'lobby';
  const winner = room.startCount > 1 ? alive[0] : null;
  if (winner) { winner.wins++; winner.alive = false; }
  if (room.classic) recordClassic(room);
  broadcast(room, { t: 'gameover', winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : null, len: winner ? winner.body.length : 0 });
  sendState(room);
  sendLobby(room);
}

// Called by server.js when a connection joins Snakewar. Returns handlers for that connection.
function join(ws, id, m) {
  const code = String(m.room || 'lobby').trim().toLowerCase().slice(0, 20) || 'lobby';
  let room = rooms.get(code);
  if (!room) { room = { code, players: new Map(), hostId: id, state: 'lobby', food: new Set(), drops: new Set(), specials: new Map(), startCount: 0, ...fieldFor(1) }; rooms.set(code, room); }
  const slot = freeSlot(room);
  if (!slot) { send(ws, { t: 'error', msg: `Room is full (${MAX_PLAYERS} players max).` }); return null; }
  const me = { id, ws, slot, name: String(m.name || 'Player').trim().slice(0, 14) || 'Player', alive: false, body: [], dir: 'R', queue: [], grow: 0, fx: {}, wins: 0 };
  room.players.set(id, me);
  if (room.state === 'lobby') { Object.assign(room, fieldFor(room.players.size)); room.food.clear(); room.drops.clear(); room.specials.clear(); } // preview the size the next round will use
  send(ws, { t: 'welcome', id, room: code, w: room.w, h: room.h, tick: TICK_MS, specials: SPECIALS });
  sendLobby(room);
  sendState(room);
  log(room, `${me.name} joined`);

  return {
    message(m) {
      if (m.t === 'dir' && DIRS[m.d] && me.alive && me.queue.length < 3) {
        const last = me.queue.length ? me.queue[me.queue.length - 1] : me.dir;
        if (m.d !== last && !isReverse(last, m.d)) me.queue.push(m.d);
      } else if (m.t === 'start' && me.id === room.hostId && room.state === 'lobby') {
        startRound(room);
      } else if (m.t === 'chat') {
        broadcast(room, { t: 'chat', id: me.id, msg: String(m.msg).slice(0, 200) });
      }
    },
    close() {
      if (room.classic && room.state !== 'lobby' && me.alive) { recordClassic(room, me); room.classic = false; } // closing the tab still saves a solo score
      room.players.delete(me.id);
      if (!room.players.size) { stopRound(room); rooms.delete(room.code); return; }
      if (room.hostId === me.id) room.hostId = room.players.values().next().value.id;
      if (me.alive) { me.alive = false; }
      log(room, `${me.name} left`);
      checkRoundOver(room);
      if (room.state === 'lobby') { Object.assign(room, fieldFor(room.players.size)); room.food.clear(); room.drops.clear(); room.specials.clear(); sendState(room); }
      sendLobby(room);
    },
  };
}

module.exports = { join, _rooms: rooms, _tick: tick }; // _rooms/_tick are for tests
