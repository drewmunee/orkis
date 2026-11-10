// Snakewar: battle-royale snake. The server owns the game: it moves every snake on a fixed tick,
// resolves collisions and food, and broadcasts the whole field to everyone in the room.
const GW = 112, GH = 63;           // 16:9 grid, fills most laptop/desktop screens
const TICK_MS = 110;               // one step per tick (two while Speed is active)
const COUNTDOWN_MS = 3000;
const MAX_PLAYERS = 12;
const START_LEN = 4;
const SPECIAL_LIFETIME = 15000;    // uneaten special foods vanish after this
const MAX_SPECIALS = 3;
const SPECIAL_CHANCE = 1 / 70;     // per tick, while below MAX_SPECIALS (~ one every 8s)
// Special foods: speed (2 steps per tick), ghost (pass through snake bodies), feast (+5 length)
const SPECIALS = { speed: 5000, ghost: 6000, feast: 0 };
const SPECIAL_KEYS = Object.keys(SPECIALS);
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

const rooms = new Map();
const cell = (x, y) => y * GW + x;
const xy = c => [c % GW, (c / GW) | 0];
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
    const c = cell(rnd(GW), rnd(GH));
    if (!occ.has(c) && !room.food.has(c) && !room.drops.has(c) && !room.specials.has(c)) return c;
  }
  return -1;
}
function spawnSnake(room, p, occ) {
  // find a spot with room to move, pointing toward the middle of the field
  for (let tries = 0; tries < 300; tries++) {
    const x = 8 + rnd(GW - 16), y = 6 + rnd(GH - 12);
    const dir = Math.abs(x - GW / 2) > Math.abs(y - GH / 2) ? (x < GW / 2 ? 'R' : 'L') : (y < GH / 2 ? 'D' : 'U');
    const [dx, dy] = DIRS[dir];
    const body = [];
    for (let i = 0; i < START_LEN; i++) body.push(cell(x - dx * i, y - dy * i));
    // keep a clear zone around the new snake
    let clear = true;
    for (const c of body) { const [cx, cy] = xy(c); for (let ox = -3; ox <= 3 && clear; ox++) for (let oy = -3; oy <= 3; oy++) if (occ.has(cell(cx + ox, cy + oy))) { clear = false; break; } }
    if (!clear) continue;
    p.body = body; p.dir = dir; p.queue = []; p.grow = 0; p.fx = {}; p.alive = true;
    for (const c of body) occ.add(c);
    return;
  }
  p.alive = false;
}

function startRound(room) {
  room.state = 'countdown';
  room.food = new Set(); room.drops = new Set(); room.specials = new Map();
  room.startCount = room.players.size;
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
  // always one regular food on the field per player in the round
  const want = Math.max(1, room.startCount || room.players.size);
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
    const [hx, hy] = xy(p.body[0]), [dx, dy] = DIRS[p.dir];
    const nx = hx + dx, ny = hy + dy;
    const off = nx < 0 || ny < 0 || nx >= GW || ny >= GH;
    const nc = off ? -1 : cell(nx, ny);
    plan.push([p, nc, off]);
    if (!off) heads.set(nc, (heads.get(nc) || []).concat(p));
  }
  const dead = [];
  for (const [p, nc, off] of plan) {
    const ghost = p.fx.ghost > Date.now();
    if (off) { dead.push([p, 'hit the wall']); continue; }
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
    if (room.food.has(nc)) { room.food.delete(nc); p.grow += 1; }
    else if (room.drops.has(nc)) { room.drops.delete(nc); p.grow += 1; }
    const sp = room.specials.get(nc);
    if (sp) {
      room.specials.delete(nc);
      if (sp.type === 'feast') p.grow += 5; else p.fx[sp.type] = Date.now() + SPECIALS[sp.type];
      broadcast(room, { t: 'ate', id: p.id, special: sp.type });
    }
  }
  for (const [p, why] of dead) kill(room, p, why);
}
const isReverse = (a, b) => DIRS[a][0] === -DIRS[b][0] && DIRS[a][1] === -DIRS[b][1];

function tick(room) {
  const alive = () => [...room.players.values()].filter(p => p.alive);
  step(room, alive());
  const fast = alive().filter(p => p.fx.speed > Date.now());
  if (fast.length) step(room, fast);
  // special foods come and go
  const now = Date.now();
  for (const [c, sp] of room.specials) if (sp.until < now) room.specials.delete(c);
  if (room.specials.size < MAX_SPECIALS && Math.random() < SPECIAL_CHANCE) {
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
    t: 'state',
    snakes: [...room.players.values()].filter(p => p.alive).map(p => ({
      id: p.id, body: p.body, dir: p.dir,
      fx: Object.fromEntries(Object.entries(p.fx).filter(([, u]) => u > now).map(([k, u]) => [k, u - now])),
    })),
    food: [...room.food], drops: [...room.drops],
    specials: [...room.specials].map(([c, sp]) => [c, sp.type, sp.until - now]),
  });
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
  broadcast(room, { t: 'gameover', winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : null, len: winner ? winner.body.length : 0 });
  sendState(room);
  sendLobby(room);
}

// Called by server.js when a connection joins Snakewar. Returns handlers for that connection.
function join(ws, id, m) {
  const code = String(m.room || 'lobby').trim().toLowerCase().slice(0, 20) || 'lobby';
  let room = rooms.get(code);
  if (!room) { room = { code, players: new Map(), hostId: id, state: 'lobby', food: new Set(), drops: new Set(), specials: new Map(), startCount: 0 }; rooms.set(code, room); }
  const slot = freeSlot(room);
  if (!slot) { send(ws, { t: 'error', msg: `Room is full (${MAX_PLAYERS} players max).` }); return null; }
  const me = { id, ws, slot, name: String(m.name || 'Player').trim().slice(0, 14) || 'Player', alive: false, body: [], dir: 'R', queue: [], grow: 0, fx: {}, wins: 0 };
  room.players.set(id, me);
  send(ws, { t: 'welcome', id, room: code, w: GW, h: GH, tick: TICK_MS, specials: SPECIALS });
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
      room.players.delete(me.id);
      if (!room.players.size) { stopRound(room); rooms.delete(room.code); return; }
      if (room.hostId === me.id) room.hostId = room.players.values().next().value.id;
      if (me.alive) { me.alive = false; }
      log(room, `${me.name} left`);
      checkRoundOver(room);
      sendLobby(room);
    },
  };
}

module.exports = { join, _rooms: rooms, _tick: tick }; // _rooms/_tick are for tests
