// Snakewar: battle-royale snake. The server owns the game: it moves every snake on a fixed tick,
// resolves collisions and food, and broadcasts the whole field to everyone in the room.
const leaderboard = require('./leaderboard');
const moderation = require('./moderation');
const swearjar = require('./swearjar');
const commands = require('./commands');
const avatars = require('./avatars');
const WORDS = require('./words4');
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
// Classic solo ramps up: one more food on the board per 30 eaten (max 3), and 1.25x game speed per 45 eaten
const CLASSIC_FOOD_EVERY = 30, CLASSIC_FOOD_MAX = 3, CLASSIC_SPEED_EVERY = 45, CLASSIC_SPEED_MUL = 1.25, MIN_TICK_MS = 30;
const soloEaten = room => Math.max(0, ...[...room.players.values()].map(p => (p.inRound && p.eaten) || 0));
const tickMs = room => room.classic ? Math.max(MIN_TICK_MS, TICK_MS / CLASSIC_SPEED_MUL ** Math.floor(soloEaten(room) / CLASSIC_SPEED_EVERY)) : TICK_MS;
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
//  bomb (held): dropped out of your tail, explodes after 3 s; everything within its radius is destroyed
//  (food, specials, blockades) and every snake with any part inside loses a quarter of its length
//  pacman (held): for 6 s you pass through enemy snakes and eat them: each enemy square you pass through
//  takes 1 off their length and adds 1 to yours; heads and ghosts are safe
//  poop (held): for 6 s you leave a slimy trail; enemies whose head crosses it are slowed
const SPECIALS = { speed: 5000, ghost: 6000, feast: 0, shears: 0, double: 20000, slow: 5000, extendo: 12000, blockade: 0, bomb: 0, token: 0, pacman: 6000, poop: 6000 };
const HELD = new Set(['ghost', 'blockade', 'bomb', 'pacman', 'poop']);   // these go to the player's item queue and are used with Space
const ITEM_MAX = 3;                            // queue size; collecting more drops the oldest
const SHEARS_FRAC = 0.25, MIN_LEN = 3;
const BLOCKADE_LEN = 5, EXTENDO_REACH = 5, TOKENS_PER_REVIVE = 3;
const MAX_BLOCKADES = 5;                       // placing a 6th removes the oldest
const BOMB_FUSE_MS = 3000, BOMB_RADIUS = 5;
// Slime from the poop item: each trail square lasts SLIME_MS; an enemy head on it is slowed for SLIME_SLOW_MS
const SLIME_MS = 8000, SLIME_SLOW_MS = 1500;
// Letter tiles (battle rounds only, separate from the special items): pick them up into a 4-letter rack
// (a 5th drops the oldest). When the 4 letters can be arranged into a valid word, the rack clears and
// you get a big reward: +WORD_GROW length, or every enemy loses a third (coin flip; ghosts are immune).
const LETTER_CHANCE = 1 / 40, MAX_LETTERS = 4, LETTER_LIFETIME = 20000, RACK_SIZE = 4;
const WORD_GROW = 12, WORD_CUT_FRAC = 1 / 3;
// letters are drawn from a bag weighted toward ones that make words (no J, Q, X or Z)
const LETTER_BAG = 'EEEEEEEEEAAAAAAAIIIIIIOOOOOOUUURRRRRSSSSSTTTTTTLLLLNNNNNNDDDDGGGBBCCMMPPFFHHVWWYYK';
// Bonus tiles: the host picks what spawns (same spawn rules either way): 'fruit' (default) - banana,
// cherries or orange; 3 of the same fruit pays the same bonus as a word - or 'letters', or 'none'.
const TILE_MODES = ['fruit', 'letters', 'none'];
const FRUITS = ['banana', 'cherry', 'orange'], FRUIT_SET = 3;
const ANAGRAMS = new Map(); // sorted letters -> a word they spell
for (const w of WORDS) { const k = [...w.toUpperCase()].sort().join(''); if (!ANAGRAMS.has(k)) ANAGRAMS.set(k, w.toUpperCase()); }
const FFA_COLORS = 12, TEAM_SHADES = 6;        // palette sizes (the colors themselves live in the client)
// Revive tokens (team matches) have their own spawner: about one every 10 s at the start, getting rarer
// as the round goes on (chance per tick divided by 1 + minutes played), at most 2 on the field.
const TOKEN_CHANCE = 1 / 90, MAX_TOKENS = 2;
// Shrinking board (battle rounds only): a 10 s warning starts 2 minutes in, or 3 s after someone dies,
// whichever comes first; after each shrink the next warning comes 30 s later (or 3 s after a death).
const SHRINK_FIRST_TEAM_MS = 120000; // team rounds: 2 minutes, or once a team (of 2+) is down to its last snake
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
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, wins: p.wins, len: p.body.length, team: p.team || null, color: p.color, shade: p.shade, avatar: p.avatar || null, spectating: !!p.spectating }));
}
function sendLobby(room) { broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId, state: room.state, teamMode: !!room.teamMode, tileMode: room.tileMode || 'fruit' }); }
function log(room, msg) { broadcast(room, { t: 'log', msg }); }
function setField(room, n) {
  Object.assign(room, fieldFor(n));
  room.bounds = { x0: 0, y0: 0, x1: room.w, y1: room.h };
  room.food.clear(); room.drops.clear(); room.bits.clear(); room.specials.clear(); room.walls.clear(); room.blockades = []; room.bombs = []; room.shrink = null; room.wallOwner = new Map();
  room.letters = new Map(); room.slime = new Map();
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
    if (!occ.has(c) && !room.food.has(c) && !room.drops.has(c) && !room.bits.has(c) && !room.specials.has(c) && !(room.letters && room.letters.has(c))) return c;
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
    p.body = body; p.dir = dir; p.queue = []; p.grow = 0; p.fx = {}; p.alive = true; p.items = []; p.letters = []; p.fruit = { banana: 0, cherry: 0, orange: 0 };
    for (const c of body) occ.add(c);
    return true;
  }
  return false;
}

// Players who typed /spectate sit the next rounds out and just watch.
const players = room => [...room.players.values()].filter(p => !p.spectating);
function startRound(room) {
  const order = players(room);
  if (!order.length) return log(room, 'Everyone is spectating: type /spectate to play.');
  room.state = 'countdown';
  room.food = new Set(); room.drops = new Set(); room.bits = new Set(); room.specials = new Map(); room.walls = new Set(); room.blockades = []; room.bombs = [];
  room.startCount = order.length;
  // Solo rounds are classic snake: walls kill, one food at a time, +1 per food, no special foods,
  // and the score (food eaten) goes on the Snakewar high-score board.
  room.classic = room.startCount === 1;
  setField(room, room.startCount);
  room.tickN = 0; room.playStart = Date.now() + COUNTDOWN_MS;
  room.nextShrinkAt = Infinity; // set below, once we know whether it's a team round
  // Team mode: shuffle everyone into red and blue (sizes differ by at most one), new teams every round.
  room.teamMatch = !!room.teamMode && room.startCount >= 2;
  room.roundTiles = room.tileMode || 'fruit'; // the host's bonus-tile choice, fixed for the round
  for (const p of room.players.values()) if (p.spectating) { p.team = null; p.inRound = false; p.alive = false; }
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
    room.tickMs = tickMs(room);
    room.timer = setInterval(() => tick(room), room.tickMs);
  }, COUNTDOWN_MS);
}
function stopRound(room) { clearTimeout(room.timer); clearInterval(room.timer); room.timer = null; }

function topUpFood(room) {
  if (room.classic) {
    const want = Math.min(CLASSIC_FOOD_MAX, 1 + Math.floor(soloEaten(room) / CLASSIC_FOOD_EVERY));
    while (room.food.size < want) { const c = randomFreeCell(room); if (c < 0) break; room.food.add(c); }
    return;
  }
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
  p.alive = false; p.items = []; p.letters = []; p.fruit = { banana: 0, cherry: 0, orange: 0 };
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
  const pac = p => p.fx.pacman > now;
  const bites = []; // [pacman snake, enemy, cell]: Pacman passing through an enemy eats from there to its tail
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
    else if (hit && hit !== p && pac(p) && enemies(room, p, hit)) {
      // Pacman slides through enemy snakes, biting off the part it enters (ghosts can't be bitten)
      if (!ghost(hit)) bites.push([p, hit, nc]);
      continue;
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
      if ((pac(p) && enemies(room, p, q)) || (pac(q) && enemies(room, q, p))) continue; // Pacman passes enemy heads by
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
    const tile = room.letters.get(nc); // a bonus tile: a letter or a fruit
    if (tile) { room.letters.delete(nc); if (tile.fruit) takeFruit(room, p, tile.fruit, x2); else takeLetter(room, p, tile.ch, x2); }
    // Poop: the square your tail sits on gets slimed while it's active
    if (p.fx.poop > now) room.slime.set(p.body[p.body.length - 1], { until: now + SLIME_MS, owner: p });
    // slime slows enemies whose head crosses it (not ghosts, never your own or your team's)
    const slime = room.slime.get(nc);
    if (slime && slime.owner !== p && enemies(room, slime.owner, p) && !ghost(p)) { delete p.fx.speed; p.fx.slow = Math.max(p.fx.slow || 0, now + SLIME_SLOW_MS); }
  }
  // Pacman bites: each enemy square you pass through costs them 1 length (taken off the end of their
  // tail, so their body stays in one piece) and gives you 1. Heads can't be bitten, and nobody drops
  // below MIN_LEN.
  for (const [p, q, c] of bites) {
    if (!p.alive || !q.alive || dead.has(p)) continue;
    if (q.body.indexOf(c) < 1 || q.body.length <= MIN_LEN) continue;
    q.body.pop();
    p.grow += p.fx.double > now ? 2 : 1;
    p.maxLen = Math.max(p.maxLen || 0, p.body.length + p.grow);
    stats.add(p, 'snakewar', 'pacman_bites'); stats.add(q, 'snakewar', 'pacman_bitten');
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

// A letter tile goes into the 4-letter rack (a 5th drops the oldest). Four letters that can be arranged
// into a word clear the rack and pay out: a big growth bonus or a big cut to every enemy (coin flip).
function takeLetter(room, p, ch, x2) {
  p.letters.push(ch);
  if (p.letters.length > RACK_SIZE) p.letters.splice(0, p.letters.length - RACK_SIZE);
  stats.add(p, 'snakewar', 'letters');
  if (p.letters.length < RACK_SIZE) return;
  const word = ANAGRAMS.get([...p.letters].sort().join(''));
  if (!word) return;
  p.letters = [];
  stats.add(p, 'snakewar', 'words');
  tileBonus(room, p, x2, `spelled ${word}`, word);
}
// A fruit adds to that fruit's count; the third of the same kind pays the bonus and resets that count.
function takeFruit(room, p, fruit, x2) {
  p.fruit[fruit] = (p.fruit[fruit] || 0) + 1;
  stats.add(p, 'snakewar', 'fruit');
  if (p.fruit[fruit] < FRUIT_SET) return;
  p.fruit[fruit] = 0;
  stats.add(p, 'snakewar', 'fruit_sets');
  tileBonus(room, p, x2, `collected 3 ${fruit === 'cherry' ? 'cherries' : fruit + 's'}`, fruit);
}
// The bonus for a word or a set of fruit: a coin flip between a big growth and a big cut to every enemy
function tileBonus(room, p, x2, what, label) {
  const now = Date.now();
  let reward;
  if (Math.random() < 0.5) { reward = 'grow'; p.grow += WORD_GROW * x2; log(room, `${p.name} ${what}: +${WORD_GROW * x2} length!`); }
  else {
    reward = 'cut';
    for (const q of alivePlayers(room)) if (enemies(room, p, q) && !(q.fx.ghost > now)) {
      const keep = Math.max(MIN_LEN, q.body.length - Math.floor(q.body.length * WORD_CUT_FRAC));
      if (keep < q.body.length) cutTail(room, q, keep);
    }
    log(room, `${p.name} ${what}: ${room.teamMatch ? `team ${teamName(p.team === 'red' ? 'blue' : 'red')}` : 'everyone else'} loses a third!`);
  }
  broadcast(room, { t: 'word', id: p.id, word: label, reward });
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
  else if (type === 'pacman') { p.fx.pacman = stack(p.fx.pacman, SPECIALS.pacman); log(room, `${p.name} turned into Pacman!`); }
  else if (type === 'poop') p.fx.poop = stack(p.fx.poop, SPECIALS.poop);
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
  stats.add(p, 'snakewar', { ghost: 'ghosts_used', blockade: 'blockades_placed', bomb: 'bombs_dropped', pacman: 'pacman_used', poop: 'poop_used' }[type]);
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
    for (const m of [room.letters, room.slime]) for (const c of [...m.keys()]) if (!inBounds(room, c)) m.delete(c);
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
    for (const m of [room.letters, room.slime]) for (const c of [...m.keys()]) if (inBlast(c)) m.delete(c);
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
  // classic solo speeds up as you eat: restart the timer at the new pace
  if (room.timer && room.state === 'playing' && tickMs(room) !== room.tickMs) {
    clearInterval(room.timer);
    room.tickMs = tickMs(room);
    room.timer = setInterval(() => tick(room), room.tickMs);
    if (room.classic) log(room, `Speed up! (${(TICK_MS / room.tickMs).toFixed(2).replace(/\.?0+$/, '')}x)`);
  }
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
  // letter tiles: their own spawner and cap, so they never crowd out special items
  for (const [c, l] of room.letters) if (l.until < now) room.letters.delete(c);
  for (const [c, sl] of room.slime) if (sl.until < now) room.slime.delete(c);
  if (!room.classic && room.roundTiles !== 'none' && room.letters.size < MAX_LETTERS && Math.random() < LETTER_CHANCE) {
    const c = randomFreeCell(room);
    if (c >= 0) room.letters.set(c, room.roundTiles === 'letters'
      ? { ch: LETTER_BAG[rnd(LETTER_BAG.length)], until: now + LETTER_LIFETIME }
      : { fruit: FRUITS[rnd(FRUITS.length)], until: now + LETTER_LIFETIME });
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
      id: p.id, body: p.body, dir: p.dir, eaten: p.eaten || 0, items: p.items, letters: p.letters || [], fruit: p.fruit,
      fx: Object.fromEntries(Object.entries(p.fx).filter(([, u]) => u > now).map(([k, u]) => [k, u - now])),
      tongue: p.fx.extendo > now ? tongueCells(room, p, p.body[0]) : undefined,
    })),
    food: [...room.food], drops: [...room.drops], bits: [...room.bits], walls: [...room.walls],
    bombs: room.bombs.map(b => [b.cell, b.at - now, BOMB_RADIUS]),
    tileMode: room.roundTiles || room.tileMode || 'fruit',
    letters: [...(room.letters || [])].map(([c, l]) => [c, l.ch || l.fruit, l.until - now]), // a letter, or banana/cherry/orange
    slime: [...(room.slime || []).keys()],
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
    room = { code, players: new Map(), hostId: id, state: 'lobby', food: new Set(), drops: new Set(), bits: new Set(), specials: new Map(), walls: new Set(), blockades: [], bombs: [], letters: new Map(), slime: new Map(), startCount: 0, teamMode: false };
    setField(room, 1); rooms.set(code, room);
  }
  const wanted = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
  const clash = moderation.nameClash(room.players.values(), wanted, m.bid); // no duplicate names in a lobby
  if (clash === 'taken') { send(ws, { t: 'error', msg: moderation.nameTaken(wanted) }); if (!room.players.size) rooms.delete(code); return null; }
  if (clash) clash.ws.terminate(); // same browser rejoining: drop its old connection
  const slot = freeSlot(room);
  if (!slot) { send(ws, { t: 'error', msg: `Room is full (${MAX_PLAYERS} players max).` }); return null; }
  const me = { id, ws, slot, bid: typeof m.bid === 'string' ? m.bid.slice(0, 40) : null, name: String(m.name || 'Player').trim().slice(0, 14) || 'Player', alive: false, body: [], dir: 'R', queue: [], grow: 0, fx: {}, items: [], wins: 0, team: null, color: slot, shade: null, avatar: avatars.clean(m.avatar) };
  room.players.set(id, me);
  if (room.state === 'lobby') setField(room, Math.max(1, players(room).length)); // preview the size the next round will use
  send(ws, { t: 'welcome', id, room: code, w: room.w, h: room.h, tick: TICK_MS, specials: SPECIALS });
  sendLobby(room);
  sendState(room);
  log(room, `${me.name} joined`);

  return {
    message(m) {
      if (m.t === 'dir' && (DIRS[m.d] || m.rel === 'a' || m.rel === 'b') && me.alive && me.queue.length < 3) {
        const last = me.queue.length ? me.queue[me.queue.length - 1] : me.dir;
        // NOKIA / VIM steering sends a relative key instead of a direction: key A (numpad 1 / H) turns up
        // when moving sideways and left when moving up or down; key B (numpad 9 / L) turns down / right.
        // It's worked out from the last queued turn, so quick double taps still do what you expect.
        const sideways = last === 'L' || last === 'R';
        const d = DIRS[m.d] ? m.d : m.rel === 'a' ? (sideways ? 'U' : 'L') : (sideways ? 'D' : 'R');
        if (d !== last && !isReverse(last, d)) me.queue.push(d);
      } else if (m.t === 'avatar') { // picked a new avatar in ⚙ Settings
        me.avatar = avatars.clean(m.a); sendLobby(room);
      } else if (m.t === 'use') {
        useItem(room, me);
      } else if (m.t === 'start' && me.id === room.hostId && room.state === 'lobby') {
        startRound(room);
      } else if (m.t === 'teammode' && me.id === room.hostId && room.state === 'lobby') {
        room.teamMode = !!m.on;
        for (const p of room.players.values()) p.team = null; // last round's teams no longer apply
        sendLobby(room);
      } else if (m.t === 'tiles' && me.id === room.hostId && room.state === 'lobby' && TILE_MODES.includes(m.mode)) {
        room.tileMode = m.mode; // bonus tiles for the next rounds: fruit, letters or none
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
        // /commands (see commands.js) answer only the sender and aren't chat
        if (commands.handle(m.msg, { me, players: room.players.values(), game: 'snakewar', spectate: () => {
          me.spectating = !me.spectating;
          if (room.state === 'lobby') { setField(room, Math.max(1, players(room).length)); sendState(room); }
          sendLobby(room);
          log(room, me.spectating ? `${me.name} is spectating` : `${me.name} is back in the game`);
          return me.spectating ? `You'll watch the next rounds instead of playing${me.alive ? ' (after this one)' : ''}. Type /spectate again to play.` : 'You\'ll play in the next round.';
        } }, line => send(ws, { t: 'log', msg: line }))) return;
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
      if (room.state === 'lobby') { setField(room, Math.max(1, players(room).length)); sendState(room); }
      sendLobby(room);
    },
  };
}

// Public lobby list for the homepage browser
function lobbies() {
  return [...rooms.values()].map(r => ({ room: r.code, players: r.players.size, names: [...r.players.values()].map(p => p.name), playing: r.state !== 'lobby', teamMode: !!r.teamMode }));
}

module.exports = { join, lobbies, _rooms: rooms, _tick: tick, _useItem: useItem }; // underscored exports are for tests
