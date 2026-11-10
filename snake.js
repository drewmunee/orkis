// Snakewar: battle-royale snake. The server owns the game: it moves every snake on a fixed tick,
// resolves collisions and food, and broadcasts the whole field to everyone in the room.
const leaderboard = require('./leaderboard');
const moderation = require('./moderation');
const swearjar = require('./swearjar');
const stats = require('./stats');
const GW = 112, GH = 63;           // full-size 16:9 field, fills most laptop/desktop screens
// Field size depends on how many are in the room when a round starts: solo is classic snake on a small
// 32x18 board; 2 players get a quarter of the full area, 3 players half, 4+ the full field. All 16:9.
const CLASSIC = { w: 32, h: 18 };
function fieldFor(n) {
  if (n <= 1) return { ...CLASSIC };
  const k = n === 2 ? 0.5 : n === 3 ? Math.SQRT1_2 : 1; // side scale: area 1/4, 1/2, full
  return { w: Math.round(GW * k), h: Math.round(GH * k) };
}
const FOOD_GROWTH = 2;              // regular food and what dead snakes leave add 2 segments
const BIT_GROWTH = 1;               // "tiny food" (cut-off tails from Shears / a shrinking board) adds 1
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
// Special foods. Value = effect duration in ms (0 = instant or no timer).
//  speed: 2 steps per tick · ghost (held): slide through snakes and blockades, immune to other players' items
//  feast: worth 5 more for every minute the round has run when it appears (+5, +10, +15 ...), grows +1 every
//  3 s while it waits, and never vanishes · shears: enemies lose 1/4 of
//  their length · double: all growth x2 · slow: enemies move at half speed (cancels their Speed instead)
//  extendo: a 5-square tongue that kills enemies who run into it and eats food it touches · blockade (held): drop 5 tail segments
//  as a permanent wall · token (team mode only): every 3 a team collects = 1 revive
//  bomb (held): dropped at your head, explodes after 5 s; everything within its radius is destroyed
//  (food, specials, blockades) and every snake with any part inside loses a quarter of its length
const SPECIALS = { speed: 5000, ghost: 6000, feast: 0, shears: 0, double: 20000, slow: 5000, extendo: 12000, blockade: 0, bomb: 0, token: 0 };
const HELD = new Set(['ghost', 'blockade', 'bomb']);   // these go to the player's item queue and are used with Space
const ITEM_MAX = 3;                            // queue size; collecting more drops the oldest
const SHEARS_FRAC = 0.25, MIN_LEN = 3;
const BLOCKADE_LEN = 5, EXTENDO_REACH = 5, TOKENS_PER_REVIVE = 3;
const MAX_BLOCKADES = 5;                       // placing a 6th removes the oldest
const BOMB_FUSE_MS = 5000, BOMB_RADIUS = 5;
const FFA_COLORS = 12, TEAM_SHADES = 6;        // palette sizes (the colors themselves live in the client)
// Revive tokens (team matches) have their own spawner: about one every 10 s at the start, getting rarer
// as the round goes on (chance per tick divided by 1 + minutes played), at most 2 on the field.
const TOKEN_CHANCE = 1 / 90, MAX_TOKENS = 2;
// Shrinking board (battle rounds only): a 10 s warning starts 2 minutes in, or 3 s after someone dies,
// whichever comes first; after each shrink the next warning comes 30 s later (or 3 s after a death).
const SHRINK_FIRST_TEAM_MS = 240000; // team rounds: 4 minutes, or once a team (of 2+) is down to its last snake
const FEAST_BASE = 5, FEAST_PER_MIN = 5, FEAST_GROW_MS = 3000, MAX_FEASTS = 2;
const SHRINK_FIRST_MS = 120000, SHRINK_AFTER_DEATH_MS = 3000, SHRINK_WARN_MS = 10000, SHRINK_EVERY_MS = 30000;
const SHRINK_FACTOR = 0.8, SHRINK_MIN_W = 24, SHRINK_MIN_H = 14;
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

const rooms = new Map();
const cell = (r, x, y) => y * r.w + x;           // cells are numbered per room, since field sizes differ
const xy = (r, c) => [c % r.w, (c / r.w) | 0];
const rnd = n => (Math.random() * n) | 0;
const inBounds = (r, c) => { const [x, y] = xy(r, c), b = r.bounds; return x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1; };
// Blockades: room.walls is every wall cell (fast lookup); room.blockades lists each placed blockade's
// cells, oldest first, so the oldest can be removed when there are too many.
function removeWalls(room, cells) {
  for (const c of cells) room.walls.delete(c);
  room.blockades = room.blockades.map(g => g.filter(c => room.walls.has(c))).filter(g => g.length);
}
const isReverse = (a, b) => DIRS[a][0] === -DIRS[b][0] && DIRS[a][1] === -DIRS[b][1];
const alivePlayers = room => [...room.players.values()].filter(p => p.alive);
// In a team match, effects aimed at "other snakes" only hit the other team.
const enemies = (room, a, b) => a !== b && !(room.teamMatch && a.team && a.team === b.team);
const teamName = t => t === 'red' ? 'Red' : 'Blue';

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function freeSlot(room) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return 0;
}
function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, wins: p.wins, len: p.body.length, team: p.team || null, color: p.color, shade: p.shade }));
}
function sendLobby(room) { broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId, state: room.state, teamMode: !!room.teamMode }); }
function log(room, msg) { broadcast(room, { t: 'log', msg }); }
function setField(room, n) {
  Object.assign(room, fieldFor(n));
  room.bounds = { x0: 0, y0: 0, x1: room.w, y1: room.h };
  room.food.clear(); room.drops.clear(); room.bits.clear(); room.specials.clear(); room.walls.clear(); room.blockades = []; room.bombs = []; room.shrink = null; room.wallOwner = new Map();
}

function occupied(room) {
  const occ = new Set(room.walls);
  for (const p of room.players.values()) if (p.alive) for (const c of p.body) occ.add(c);
  return occ;
}
// Food and special foods lean slightly toward the middle: half the time a spot is picked evenly, the
// other half from a triangular spread centred on the middle, so edges still get some.
const pick = (lo, n) => lo + (Math.random() < 0.5 ? rnd(n) : Math.min(n - 1, Math.floor((Math.random() + Math.random()) / 2 * n)));
function randomFreeCell(room, occ = occupied(room)) {
  const b = room.bounds;
  for (let i = 0; i < 500; i++) {
    const c = cell(room, pick(b.x0, b.x1 - b.x0), pick(b.y0, b.y1 - b.y0));
    if (!occ.has(c) && !room.food.has(c) && !room.drops.has(c) && !room.bits.has(c) && !room.specials.has(c)) return c;
  }
  return -1;
}
function spawnSnake(room, p, occ) {
  // find a spot inside the play area with room to move, pointing toward its middle.
  // Team rounds: red starts on the left side facing right, blue on the right side facing left.
  const b = room.bounds, W = b.x1 - b.x0, H = b.y1 - b.y0;
  const side = room.teamMatch ? p.team : null;
  for (let tries = 0; tries < 400; tries++) {
    const mx = Math.min(8, W >> 2), my = Math.min(6, H >> 2);
    const span = W - 2 * mx, third = Math.max(1, Math.floor(span * 0.35));
    const x = side === 'red' ? b.x0 + mx + rnd(third) : side === 'blue' ? b.x1 - mx - 1 - rnd(third) : b.x0 + mx + rnd(span);
    const y = b.y0 + my + rnd(H - 2 * my);
    const dir = side === 'red' ? 'R' : side === 'blue' ? 'L'
      : Math.abs(x - (b.x0 + W / 2)) > Math.abs(y - (b.y0 + H / 2)) ? (x < b.x0 + W / 2 ? 'R' : 'L') : (y < b.y0 + H / 2 ? 'D' : 'U');
    const [dx, dy] = DIRS[dir];
    const body = [];
    for (let i = 0; i < START_LEN; i++) body.push(cell(room, x - dx * i, y - dy * i));
    let clear = true; // keep a clear zone around the new snake
    for (const c of body) { const [cx, cy] = xy(room, c); for (let ox = -3; ox <= 3 && clear; ox++) for (let oy = -3; oy <= 3; oy++) if (occ.has(cell(room, cx + ox, cy + oy))) { clear = false; break; } }
    if (!clear) continue;
    p.body = body; p.dir = dir; p.queue = []; p.grow = 0; p.fx = {}; p.alive = true; p.items = [];
    for (const c of body) occ.add(c);
    return true;
  }
  return false;
}

function startRound(room) {
  room.state = 'countdown';
  room.food = new Set(); room.drops = new Set(); room.bits = new Set(); room.specials = new Map(); room.walls = new Set(); room.blockades = []; room.bombs = [];
  room.startCount = room.players.size;
  // Solo rounds are classic snake: walls kill, one food at a time, +1 per food, no special foods,
  // and the score (food eaten) goes on the Snakewar high-score board.
  room.classic = room.startCount === 1;
  setField(room, room.startCount);
  room.tickN = 0; room.playStart = Date.now() + COUNTDOWN_MS;
  room.nextShrinkAt = Infinity; // set below, once we know whether it's a team round
  // Team mode: shuffle everyone into red and blue (sizes differ by at most one), new teams every round.
  room.teamMatch = !!room.teamMode && room.startCount >= 2;
  const order = [...room.players.values()];
  for (let i = order.length - 1; i > 0; i--) { const j = rnd(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  order.forEach((p, i) => { p.team = room.teamMatch ? (i % 2 ? 'blue' : 'red') : null; p.eaten = 0; p.inRound = true; });
  room.teams = { red: { tokens: 0, revives: 0 }, blue: { tokens: 0, revives: 0 } };
  room.wallOwner = new Map();
  for (const p of order) { p.maxLen = START_LEN; stats.add(p, 'snakewar', { played: 1, [room.classic ? 'classic_runs' : room.teamMatch ? 'team_games' : 'ffa_games']: 1 }); }
  room.teamSize = { red: order.filter(p => p.team === 'red').length, blue: order.filter(p => p.team === 'blue').length };
  room.nextShrinkAt = room.classic ? Infinity : room.playStart + (room.teamMatch ? SHRINK_FIRST_TEAM_MS : SHRINK_FIRST_MS);
  const occ = new Set();
  for (const p of order) if (!spawnSnake(room, p, occ)) p.alive = false;
  topUpFood(room);
  broadcast(room, { t: 'start', countdown: COUNTDOWN_MS, players: playerList(room), teamMatch: room.teamMatch });
  if (room.teamMatch) for (const t of ['red', 'blue']) log(room, `${teamName(t)} team: ${order.filter(p => p.team === t).map(p => p.name).join(', ')}`);
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

// info: { kind, by } - how they died and which snake gets the credit (if any). Kinds: self (own body or
// own blockade), snake (ran into someone / turned into a head), tongue, blockade, head_on (nobody gets
// credit), wall (classic), shrink, left (not counted as a death)
function kill(room, p, why, info = {}) {
  p.alive = false; p.items = [];
  stats.best(p, 'snakewar', 'longest', p.maxLen || p.body.length);
  if (info.kind && info.kind !== 'left') {
    stats.add(p, 'snakewar', { deaths: 1, ['deaths_' + info.kind]: 1 });
    if (info.by && info.by !== p) stats.add(info.by, 'snakewar', { kills: 1, ...(info.kind === 'tongue' ? { tongue_kills: 1 } : info.kind === 'blockade' ? { blockade_kills: 1 } : {}) });
  }
  // a dead snake breaks into food: every other segment (inside the play area) is left behind
  p.body.forEach((c, i) => { if (i % 2 === 0 && inBounds(room, c)) room.drops.add(c); });
  log(room, `${p.name} ${why}`);
  // a death brings the next board shrink closer
  // a death brings the next board shrink closer; in team rounds only once a team of 2+ is down to its last snake
  const lastStanding = room.teamMatch && ['red', 'blue'].some(t => room.teamSize[t] >= 2 && alivePlayers(room).filter(q => q.team === t).length === 1);
  if (!room.classic && !room.shrink && (!room.teamMatch || lastStanding)) room.nextShrinkAt = Math.min(room.nextShrinkAt, Date.now() + SHRINK_AFTER_DEATH_MS);
}
// Cut a snake's body from index i to the tail; the cut part turns into tiny food.
function cutTail(room, p, i) {
  for (const c of p.body.splice(i)) if (inBounds(room, c) && !room.walls.has(c)) room.bits.add(c);
  p.grow = 0;
}
// The tongue: up to EXTENDO_REACH cells straight ahead of the head (stops at blockades)
function tongueCells(room, p, head) {
  const out = [], [dx, dy] = DIRS[p.dir], b = room.bounds, W = b.x1 - b.x0, H = b.y1 - b.y0;
  let [x, y] = xy(room, head);
  for (let i = 0; i < EXTENDO_REACH; i++) {
    x += dx; y += dy;
    if (room.classic && (x < b.x0 || y < b.y0 || x >= b.x1 || y >= b.y1)) break;
    x = b.x0 + ((x - b.x0) % W + W) % W; y = b.y0 + ((y - b.y0) % H + H) % H;
    const c = cell(room, x, y);
    if (room.walls.has(c)) break;
    out.push(c);
  }
  return out;
}

function step(room, movers) {
  const now = Date.now();
  const occ = new Map(); // cell -> snake occupying it after tails move (blockades count too)
  for (const c of room.walls) occ.set(c, 'wall');
  for (const p of room.players.values()) if (p.alive) {
    const keepTail = !movers.includes(p) || p.grow > 0;
    p.body.forEach((c, i) => { if (i < p.body.length - 1 || keepTail) occ.set(c, p); });
  }
  const heads = new Map(); // new head cell -> snakes moving there
  const plan = [];
  const b = room.bounds, W = b.x1 - b.x0, H = b.y1 - b.y0;
  for (const p of movers) {
    p.turned = false;
    if (p.queue.length) { const d = p.queue.shift(); if (!isReverse(p.dir, d) && d !== p.dir) { p.dir = d; p.turned = true; } }
    const [hx, hy] = xy(room, p.body[0]), [dx, dy] = DIRS[p.dir];
    const nx = hx + dx, ny = hy + dy;
    const off = nx < b.x0 || ny < b.y0 || nx >= b.x1 || ny >= b.y1;
    if (room.classic && off) { plan.push([p, -1]); continue; } // classic: walls kill
    // battle rounds wrap: leaving one edge of the play area brings you in on the opposite side
    const nc = cell(room, b.x0 + ((nx - b.x0) % W + W) % W, b.y0 + ((ny - b.y0) % H + H) % H);
    plan.push([p, nc]);
    heads.set(nc, (heads.get(nc) || []).concat(p));
  }
  const ghost = p => p.fx.ghost > now;
  const dead = new Map(); // snake -> { why, kind, by }  (see kill())
  const D = (why, kind, by) => ({ why, kind, by });
  for (const [p, nc] of plan) {
    if (nc < 0) { dead.set(p, D('hit the wall', 'wall')); continue; }
    const hit = occ.get(nc);
    if (hit === 'wall') {
      if (!ghost(p)) { // ghosts slip through blockades; otherwise whoever placed it gets the credit
        const owner = room.wallOwner.get(nc);
        dead.set(p, owner === p ? D('ran into their own blockade', 'self') : D(owner ? `hit ${owner.name}'s blockade` : 'hit a blockade', 'blockade', owner));
        continue;
      }
    }
    else if (hit && !ghost(p)) {
      // swapping heads with a snake coming straight at you is a true head-on: both go, no credit
      if (hit !== p && hit.body[0] === nc && movers.includes(hit) && isReverse(hit.dir, p.dir)) {
        dead.set(p, D(`collided head-on with ${hit.name}`, 'head_on')); dead.set(hit, D(`collided head-on with ${p.name}`, 'head_on'));
      } else dead.set(p, hit === p ? D('ran into themselves', 'self') : D(`crashed into ${hit.name}`, 'snake', hit));
      continue;
    }
    // two heads arriving at the same square: facing each other, both die; otherwise whoever turned
    // into the other (hit them from the side) dies and the other carries on
    for (const q of heads.get(nc)) {
      if (q === p || ghost(p) || ghost(q)) continue;
      if (isReverse(p.dir, q.dir) || p.turned === q.turned) dead.set(p, D(`collided head-on with ${q.name}`, 'head_on'));
      else if (p.turned) dead.set(p, D(`ran into ${q.name}`, 'snake', q)); // turned into q's head: q gets the kill
    }
  }
  // Extendo tongues kill enemies whose head ends up on them (ghosts are safe; never your own tongue)
  const newHead = p => { const e = plan.find(([q]) => q === p); return e && e[1] >= 0 && !dead.has(p) ? e[1] : p.body[0]; };
  const tongues = [];
  for (const q of alivePlayers(room)) if (q.fx.extendo > now && !dead.has(q)) tongues.push([q, new Set(tongueCells(room, q, newHead(q)))]);
  for (const p of alivePlayers(room)) {
    if (dead.has(p) || ghost(p)) continue;
    const h = newHead(p);
    for (const [q, cells] of tongues) if (enemies(room, q, p) && cells.has(h)) { dead.set(p, D(`got caught by ${q.name}'s tongue`, 'tongue', q)); break; }
  }
  for (const [p, nc] of plan) {
    if (dead.has(p)) continue;
    p.body.unshift(nc);
    if (p.grow > 0) p.grow--; else p.body.pop();
    const x2 = p.fx.double > now ? 2 : 1; // Double: all growth counts twice
    if (room.food.has(nc)) { room.food.delete(nc); p.eaten++; p.grow += room.classic ? 1 : FOOD_GROWTH * x2; stats.add(p, 'snakewar', 'food'); }
    else if (room.drops.has(nc)) { room.drops.delete(nc); p.grow += FOOD_GROWTH * x2; stats.add(p, 'snakewar', { food: 1, remains_eaten: 1 }); }
    else if (room.bits.has(nc)) { room.bits.delete(nc); p.grow += BIT_GROWTH * x2; stats.add(p, 'snakewar', { food: 1, tiny_food: 1 }); }
    p.maxLen = Math.max(p.maxLen || 0, p.body.length + p.grow);
    const sp = room.specials.get(nc);
    if (sp) { room.specials.delete(nc); pickUp(room, p, sp, x2); }
  }
  // Extendo also slurps up any food its tongue touches (food, remains and tiny food; not special items),
  // exactly as if the snake had eaten it
  for (const p of alivePlayers(room)) {
    if (!(p.fx.extendo > now) || dead.has(p)) continue;
    const x2 = p.fx.double > now ? 2 : 1;
    for (const c of tongueCells(room, p, p.body[0])) {
      if (room.food.has(c)) { room.food.delete(c); p.eaten++; p.grow += FOOD_GROWTH * x2; stats.add(p, 'snakewar', { food: 1, tongue_food: 1 }); }
      else if (room.drops.has(c)) { room.drops.delete(c); p.grow += FOOD_GROWTH * x2; stats.add(p, 'snakewar', { food: 1, remains_eaten: 1, tongue_food: 1 }); }
      else if (room.bits.has(c)) { room.bits.delete(c); p.grow += BIT_GROWTH * x2; stats.add(p, 'snakewar', { food: 1, tiny_food: 1, tongue_food: 1 }); }
    }
  }
  for (const [p, d] of dead) if (p.alive) kill(room, p, d.why, d);
}

const feastValue = (sp, now = Date.now()) => sp.value + Math.floor((now - sp.born) / FEAST_GROW_MS);
// timed effects stack: picking up / using another adds its full time to whatever is left
const stack = (until, ms) => Math.max(until || 0, Date.now()) + ms;
function pickUp(room, p, sp, x2) {
  const now = Date.now(), type = sp.type;
  if (type !== 'token') stats.add(p, 'snakewar', 'specials');
  if (HELD.has(type)) {
    p.items.push(type);
    if (p.items.length > ITEM_MAX) p.items.splice(0, p.items.length - ITEM_MAX);
  } else if (type === 'feast') p.grow += feastValue(sp, now) * x2;
  else if (type === 'shears') {
    for (const q of alivePlayers(room)) if (enemies(room, p, q) && !(q.fx.ghost > now)) { // ghosts are immune
      const keep = Math.max(MIN_LEN, q.body.length - Math.floor(q.body.length * SHEARS_FRAC));
      if (keep < q.body.length) cutTail(room, q, keep);
    }
    log(room, `${p.name} grabbed Shears: ${room.teamMatch ? `team ${teamName(p.team === 'red' ? 'blue' : 'red')}` : 'everyone else'} loses a quarter`);
  } else if (type === 'slow') {
    // Slow cancels an enemy's Speed instead of slowing them
    for (const q of alivePlayers(room)) if (enemies(room, p, q) && !(q.fx.ghost > now)) { if (q.fx.speed > now) delete q.fx.speed; else q.fx.slow = stack(q.fx.slow, SPECIALS.slow); }
    log(room, `${p.name} grabbed Slow`);
  } else if (type === 'speed') { delete p.fx.slow; p.fx.speed = stack(p.fx.speed, SPECIALS.speed); } // Speed always works, even when slowed
  else if (type === 'token') {
    const t = room.teams[p.team];
    if (t) {
      t.tokens++;
      stats.add(p, 'snakewar', 'tokens');
      if (t.tokens >= TOKENS_PER_REVIVE) { t.tokens -= TOKENS_PER_REVIVE; t.revives++; stats.add(p, 'snakewar', 'revives_earned'); log(room, `Team ${teamName(p.team)} earned a revive!`); }
    }
  } else p.fx[type] = stack(p.fx[type], SPECIALS[type]);
  broadcast(room, { t: 'ate', id: p.id, special: type });
}

// Use the oldest held item (Space).
function useItem(room, p) {
  if (!p.alive || room.state !== 'playing' || !p.items.length) return;
  const type = p.items[0], now = Date.now();
  if (type === 'ghost') p.fx.ghost = stack(p.fx.ghost, SPECIALS.ghost);
  else if (type === 'blockade') {
    const n = Math.min(BLOCKADE_LEN, p.body.length - MIN_LEN);
    if (n < 1) return send(p.ws, { t: 'note', msg: 'Too short to drop a blockade' });
    const cells = p.body.splice(p.body.length - n).filter(c => !room.walls.has(c));
    for (const c of cells) { room.walls.add(c); room.wallOwner.set(c, p); }
    room.blockades.push(cells);
    while (room.blockades.length > MAX_BLOCKADES) removeWalls(room, room.blockades[0]); // oldest goes
    p.grow = Math.max(0, p.grow - n);
    log(room, `${p.name} dropped a blockade`);
  } else if (type === 'bomb') {
    room.bombs.push({ cell: p.body[p.body.length - 1], at: now + BOMB_FUSE_MS, by: p.name, owner: p }); // dropped out of your tail
    log(room, `${p.name} dropped a bomb!`);
  }
  stats.add(p, 'snakewar', { ghost: 'ghosts_used', blockade: 'blockades_placed', bomb: 'bombs_dropped' }[type]);
  p.items.shift();
  broadcast(room, { t: 'used', id: p.id, item: type });
}

// Revives (team mode): a team with a revive banked brings a dead teammate straight back.
function revive(room) {
  if (!room.teamMatch) return;
  for (const t of ['red', 'blue']) {
    const team = room.teams[t];
    while (team.revives > 0) {
      const p = [...room.players.values()].find(q => q.inRound && q.team === t && !q.alive);
      if (!p || !spawnSnake(room, p, occupied(room))) break;
      team.revives--; stats.add(p, 'snakewar', 'times_revived');
      log(room, `${p.name} was revived by team ${teamName(t)}`);
    }
  }
}

function shrinkTick(room) {
  if (room.classic) return;
  const now = Date.now(), b = room.bounds;
  if (!room.shrink && now >= room.nextShrinkAt) {
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    const nw = Math.max(SHRINK_MIN_W, Math.round(W * SHRINK_FACTOR)), nh = Math.max(SHRINK_MIN_H, Math.round(H * SHRINK_FACTOR));
    if (nw >= W && nh >= H) { room.nextShrinkAt = Infinity; return; } // already as small as it gets
    const x0 = b.x0 + ((W - nw) >> 1), y0 = b.y0 + ((H - nh) >> 1);
    room.shrink = { at: now + SHRINK_WARN_MS, bounds: { x0, y0, x1: x0 + nw, y1: y0 + nh } };
    log(room, 'The board shrinks in 10 seconds!');
  }
  if (room.shrink && now >= room.shrink.at) {
    room.bounds = room.shrink.bounds; room.shrink = null; room.nextShrinkAt = now + SHRINK_EVERY_MS;
    // anything outside the new edge is gone; a snake loses everything from its first segment outside
    // the edge to its tail, and whatever of that cut part was still inside turns into tiny food
    for (const p of alivePlayers(room)) {
      const i = p.body.findIndex(c => !inBounds(room, c));
      if (i === 0) kill(room, p, 'was caught outside the shrinking board', { kind: 'shrink' });
      else if (i > 0) cutTail(room, p, i);
    }
    for (const set of [room.food, room.drops, room.bits]) for (const c of [...set]) if (!inBounds(room, c)) set.delete(c);
    removeWalls(room, [...room.walls].filter(c => !inBounds(room, c)));
    room.bombs = room.bombs.filter(b => inBounds(room, b.cell));
    for (const c of [...room.specials.keys()]) if (!inBounds(room, c)) room.specials.delete(c);
    log(room, 'The board shrank!');
  }
}

// Bombs: after the fuse, wipe out everything within the radius and take a quarter off every snake
// that has any part inside it (the bomber included). Cut tails outside the blast become tiny food.
function bombTick(room) {
  const now = Date.now();
  for (const bomb of room.bombs.filter(b => b.at <= now)) {
    const [bx, by] = xy(room, bomb.cell);
    const inBlast = c => { const [x, y] = xy(room, c); return (x - bx) ** 2 + (y - by) ** 2 <= BOMB_RADIUS ** 2; };
    for (const set of [room.food, room.drops, room.bits]) for (const c of [...set]) if (inBlast(c)) set.delete(c);
    for (const c of [...room.specials.keys()]) if (inBlast(c)) room.specials.delete(c);
    removeWalls(room, [...room.walls].filter(inBlast));
    const hurt = [];
    for (const p of alivePlayers(room)) if (!(p.fx.ghost > now) && p.body.some(inBlast)) { // ghosts ride out the blast
      const keep = Math.max(MIN_LEN, p.body.length - Math.floor(p.body.length * SHEARS_FRAC));
      for (const c of p.body.splice(keep)) if (!inBlast(c) && inBounds(room, c) && !room.walls.has(c)) room.bits.add(c);
      p.grow = 0; hurt.push(p.name);
      stats.add(p, 'snakewar', 'bombed'); if (bomb.owner && bomb.owner !== p) stats.add(bomb.owner, 'snakewar', 'bomb_hits');
    }
    broadcast(room, { t: 'boom', cell: bomb.cell, r: BOMB_RADIUS });
    log(room, `${bomb.by}'s bomb exploded${hurt.length ? ': ' + hurt.join(', ') + ' got hit' : ''}`);
  }
  room.bombs = room.bombs.filter(b => b.at > now);
}

function tick(room) {
  const now0 = Date.now(), odd = room.tickN++ % 2 === 1;
  const slowed = p => p.fx.slow > now0;
  step(room, alivePlayers(room).filter(p => !(slowed(p) && odd)));      // slowed snakes skip every other tick
  const fast = alivePlayers(room).filter(p => p.fx.speed > Date.now() && !slowed(p));
  if (fast.length) step(room, fast);
  revive(room);
  bombTick(room);
  shrinkTick(room);
  // special foods come and go (revive tokens only appear in team matches)
  const now = Date.now();
  for (const [c, sp] of room.specials) if (sp.until < now) room.specials.delete(c);
  const counts = { token: 0, feast: 0, other: 0 };
  for (const sp of room.specials.values()) counts[sp.type === 'token' || sp.type === 'feast' ? sp.type : 'other']++;
  const minutes = Math.max(0, now - room.playStart) / 60000;
  if (!room.classic && counts.other < MAX_SPECIALS && Math.random() < SPECIAL_CHANCE) {
    const pool = Object.keys(SPECIALS).filter(k => k !== 'token' && (k !== 'feast' || counts.feast < MAX_FEASTS));
    const type = pool[rnd(pool.length)], c = randomFreeCell(room);
    // feasts stay until eaten and start bigger the later they appear
    if (c >= 0) room.specials.set(c, type === 'feast'
      ? { type, until: Infinity, born: now, value: FEAST_BASE + FEAST_PER_MIN * Math.floor(minutes) }
      : { type, until: now + SPECIAL_LIFETIME });
  }
  if (room.teamMatch && counts.token < MAX_TOKENS && Math.random() < TOKEN_CHANCE / (1 + minutes)) {
    const c = randomFreeCell(room);
    if (c >= 0) room.specials.set(c, { type: 'token', until: now + SPECIAL_LIFETIME });
  }
  topUpFood(room);
  sendState(room);
  checkRoundOver(room);
}

function sendState(room) {
  const now = Date.now();
  broadcast(room, {
    t: 'state', w: room.w, h: room.h, classic: !!room.classic, bounds: room.bounds,
    shrink: room.shrink ? { left: room.shrink.at - now, bounds: room.shrink.bounds } : null,
    teams: room.teamMatch && room.state !== 'lobby' ? room.teams : null, // only during a team round
    snakes: alivePlayers(room).map(p => ({
      id: p.id, body: p.body, dir: p.dir, eaten: p.eaten || 0, items: p.items,
      fx: Object.fromEntries(Object.entries(p.fx).filter(([, u]) => u > now).map(([k, u]) => [k, u - now])),
      tongue: p.fx.extendo > now ? tongueCells(room, p, p.body[0]) : undefined,
    })),
    food: [...room.food], drops: [...room.drops], bits: [...room.bits], walls: [...room.walls],
    bombs: room.bombs.map(b => [b.cell, b.at - now, BOMB_RADIUS]),
    specials: [...room.specials].map(([c, sp]) => [c, sp.type, sp.until === Infinity ? null : sp.until - now, sp.type === 'feast' ? feastValue(sp, now) : undefined]),
  });
}

// Classic solo: save the score (food eaten) and tell the player how it compares to their best.
function recordClassic(room, p = [...room.players.values()][0]) {
  if (!p) return;
  const score = p.eaten || 0;
  if (!score) return send(p.ws, { t: 'classic', score: 0 });
  stats.best(p, 'snakewar', 'best_classic', score);
  leaderboard.submit('snakewar', p, score).then(
    r => send(p.ws, { t: 'classic', score, ...r }),
    err => { console.error('snake leaderboard write failed:', err.message); send(p.ws, { t: 'classic', score, error: true }); });
}
function endRound(room, msg) {
  stopRound(room);
  for (const p of alivePlayers(room)) stats.best(p, 'snakewar', 'longest', p.maxLen || p.body.length);
  room.state = 'lobby';
  for (const p of room.players.values()) { p.alive = false; p.inRound = false; }
  broadcast(room, { t: 'gameover', ...msg });
  sendState(room);
  sendLobby(room);
}
function checkRoundOver(room) {
  if (room.state !== 'playing' && room.state !== 'countdown') return;
  const alive = alivePlayers(room);
  if (room.teamMatch) {
    // a team is still in while it has a snake alive (revives are spent the moment someone dies)
    const teams = new Set(alive.map(p => p.team));
    if (teams.size > 1) return;
    const winnerTeam = alive.length ? alive[0].team : null;
    for (const p of room.players.values()) if (winnerTeam && p.inRound && p.team === winnerTeam) stats.add(p, 'snakewar', 'wins_team');
    return endRound(room, { winnerTeam });
  }
  const over = room.startCount > 1 ? alive.length <= 1 : alive.length === 0;
  if (!over) return;
  const winner = room.startCount > 1 ? alive[0] : null;
  const len = winner ? winner.body.length : 0;
  if (winner) { winner.wins++; stats.add(winner, 'snakewar', 'wins_ffa'); }
  if (room.classic) recordClassic(room);
  endRound(room, { winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : null, len });
}

// Called by server.js when a connection joins Snakewar. Returns handlers for that connection.
function join(ws, id, m) {
  const code = String(m.room || 'lobby').trim().toLowerCase().slice(0, 20) || 'lobby';
  let room = rooms.get(code);
  if (!room) {
    room = { code, players: new Map(), hostId: id, state: 'lobby', food: new Set(), drops: new Set(), bits: new Set(), specials: new Map(), walls: new Set(), blockades: [], bombs: [], startCount: 0, teamMode: false };
    setField(room, 1); rooms.set(code, room);
  }
  const wanted = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
  const clash = moderation.nameClash(room.players.values(), wanted, m.bid); // no duplicate names in a lobby
  if (clash === 'taken') { send(ws, { t: 'error', msg: moderation.nameTaken(wanted) }); if (!room.players.size) rooms.delete(code); return null; }
  if (clash) clash.ws.terminate(); // same browser rejoining: drop its old connection
  const slot = freeSlot(room);
  if (!slot) { send(ws, { t: 'error', msg: `Room is full (${MAX_PLAYERS} players max).` }); return null; }
  const me = { id, ws, slot, bid: typeof m.bid === 'string' ? m.bid.slice(0, 40) : null, name: String(m.name || 'Player').trim().slice(0, 14) || 'Player', alive: false, body: [], dir: 'R', queue: [], grow: 0, fx: {}, items: [], wins: 0, team: null, color: slot, shade: null };
  room.players.set(id, me);
  if (room.state === 'lobby') setField(room, room.players.size); // preview the size the next round will use
  send(ws, { t: 'welcome', id, room: code, w: room.w, h: room.h, tick: TICK_MS, specials: SPECIALS });
  sendLobby(room);
  sendState(room);
  log(room, `${me.name} joined`);

  return {
    message(m) {
      if (m.t === 'dir' && DIRS[m.d] && me.alive && me.queue.length < 3) {
        const last = me.queue.length ? me.queue[me.queue.length - 1] : me.dir;
        if (m.d !== last && !isReverse(last, m.d)) me.queue.push(m.d);
      } else if (m.t === 'use') {
        useItem(room, me);
      } else if (m.t === 'start' && me.id === room.hostId && room.state === 'lobby') {
        startRound(room);
      } else if (m.t === 'teammode' && me.id === room.hostId && room.state === 'lobby') {
        room.teamMode = !!m.on;
        for (const p of room.players.values()) p.team = null; // last round's teams no longer apply
        sendLobby(room);
      } else if (m.t === 'color' && (m.d === 1 || m.d === -1)) {
        // pick your color while you're not in play (dead, spectating or between rounds):
        // any color normally, or a shade of your team's color in team mode
        if (me.alive && room.state !== 'lobby') return;
        if (me.team || room.teamMode) {
          const mates = [...room.players.values()].filter(q => q.team && q.team === me.team).sort((a, b) => a.slot - b.slot);
          const cur = me.shade ?? Math.max(0, mates.indexOf(me)) % TEAM_SHADES;
          me.shade = (cur + m.d + TEAM_SHADES) % TEAM_SHADES;
        } else me.color = ((me.color - 1 + m.d + FFA_COLORS) % FFA_COLORS) + 1;
        sendLobby(room);
      } else if (m.t === 'chat') {
        broadcast(room, { t: 'chat', id: me.id, msg: String(m.msg).slice(0, 200) });
        if (moderation.hasSwear(m.msg)) swearjar.addQuarter(me).then(line => log(room, line), e => console.error('swear jar failed:', e.message)); // a quarter in the jar
      }
    },
    close() {
      if (room.classic && room.state !== 'lobby' && me.alive) { recordClassic(room, me); room.classic = false; } // closing the tab still saves a solo score
      room.players.delete(me.id);
      if (!room.players.size) { stopRound(room); rooms.delete(room.code); return; }
      if (room.hostId === me.id) room.hostId = room.players.values().next().value.id;
      if (me.alive) kill(room, me, 'left', { kind: 'left' });
      else log(room, `${me.name} left`);
      checkRoundOver(room);
      if (room.state === 'lobby') { setField(room, room.players.size); sendState(room); }
      sendLobby(room);
    },
  };
}

// Public lobby list for the homepage browser
function lobbies() {
  return [...rooms.values()].map(r => ({ room: r.code, players: r.players.size, names: [...r.players.values()].map(p => p.name), playing: r.state !== 'lobby', teamMode: !!r.teamMode }));
}

module.exports = { join, lobbies, _rooms: rooms, _tick: tick, _useItem: useItem }; // underscored exports are for tests
