// Snakewar bots: server-side players that choose a direction (and sometimes use an item) every tick, under
// exactly the same rules as people. They're meant to be beatable but not dumb:
//  1. Survive: of the three possible moves, rule out crashes, prefer moves that lead into open space
//     (capped flood fill) and avoid squares a bigger snake's head could reach next tick.
//  2. Go for the best nearby target (food, specials, bonus tiles, revive tokens) by value / distance,
//     using one breadth-first search from the head that remembers each cell's first step.
//  3. Now and then go aggressive: aim a few squares ahead of a nearby smaller enemy's head to cut it off.
//     Pacman makes them hunt enemy bodies.
//  4. Use the held item when it fits: Ghost / Stone to escape traps, Blockade / Poop / Bomb against snakes
//     following them, Pacman when enemy bodies are close.
// Imperfections: short look-ahead, a small random wobble on every decision, an occasional missed tick,
// a reaction delay before using items, and less caution while hunting.
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const OPP = { U: 'D', D: 'U', L: 'R', R: 'L' };
const SEARCH_NODES = 1600, SPACE_CAP = 90, HUNT_MS = 6000;
const rnd = n => Math.floor(Math.random() * n);

// the square one step from c in direction d, wrapping inside the play area (or -1 off a classic wall)
function stepCell(room, c, d) {
  const b = room.bounds, W = b.x1 - b.x0, H = b.y1 - b.y0;
  const x = c % room.w + DIRS[d][0], y = Math.floor(c / room.w) + DIRS[d][1];
  if (room.classic && (x < b.x0 || y < b.y0 || x >= b.x1 || y >= b.y1)) return -1;
  return (b.y0 + ((y - b.y0) % H + H) % H) * room.w + b.x0 + ((x - b.x0) % W + W) % W;
}
const dist2 = (room, a, b) => { const dx = a % room.w - b % room.w, dy = Math.floor(a / room.w) - Math.floor(b / room.w); return dx * dx + dy * dy; };

// What's solid this tick, shared by every bot in the room: blockades and snake bodies (tails that will
// move away this tick are left open). Cells near a bomb about to go off count as dangerous.
function board(room, A, now) {
  if (room._bot && room._bot.tick === room.tickN) return room._bot;
  const solid = new Map(), danger = new Set();
  for (const c of room.walls) solid.set(c, 'wall');
  for (const q of A.alivePlayers(room)) {
    if (q.spawnUntil > now) continue;
    const moving = !(q.fx.stone > now) && q.grow <= 0;
    q.body.forEach((c, i) => { if (!(moving && i === q.body.length - 1)) solid.set(c, q); });
  }
  for (const bomb of room.bombs) if (bomb.at - now < 2200) {
    const bx = bomb.cell % room.w, by = Math.floor(bomb.cell / room.w), r = 6;
    for (let y = by - r; y <= by + r; y++) for (let x = bx - r; x <= bx + r; x++)
      if ((x - bx) ** 2 + (y - by) ** 2 <= r * r && x >= 0 && y >= 0 && x < room.w && y < room.h) danger.add(y * room.w + x);
  }
  if (room.shrink) { // squares outside the coming edge
    const b = room.shrink.bounds;
    for (let y = room.bounds.y0; y < room.bounds.y1; y++) for (let x = room.bounds.x0; x < room.bounds.x1; x++)
      if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) danger.add(y * room.w + x);
  }
  return (room._bot = { tick: room.tickN, solid, danger });
}

function think(room, p, A) {
  const now = Date.now();
  const st = p.brain || (p.brain = { aggro: 0.25 + Math.random() * 0.5, huntUntil: 0, huntId: null, nextHuntCheck: now + 4000 + rnd(6000), itemReadyAt: 0, holdingSince: 0 });
  if (p.queue.length || p.fx.stone > now || p.spawnUntil > now) return;
  const { solid, danger } = board(room, A, now);
  const ghostly = p.fx.ghost > now || p.fx.shield > now, pac = p.fx.pacman > now;
  const blocked = c => {
    if (c < 0) return true;
    const s = solid.get(c);
    if (!s) return false;
    if (s !== 'wall' && s !== p && s.fx.stone > now) return true; // stone kills everyone
    if (ghostly) return false;
    if (s === 'wall') return true;
    if (pac && s !== p && A.enemies(room, p, s)) return false; // Pacman slides through enemies
    return true;
  };
  const head = p.body[0];
  const enemies = A.alivePlayers(room).filter(q => q !== p && A.enemies(room, p, q) && !(q.spawnUntil > now));
  const others = A.alivePlayers(room).filter(q => q !== p && !(q.spawnUntil > now));

  // --- 1. the three possible moves, each with the open space it leads to and its risk ---
  const options = Object.keys(DIRS).filter(d => d !== OPP[p.dir]).map(d => {
    const c = stepCell(room, head, d);
    if (blocked(c)) return { d, c, dead: true };
    // capped flood fill: how much room is there after this move?
    const seen = new Set([c, head]), queue = [c];
    const cap = Math.min(SPACE_CAP, p.body.length * 2 + 20);
    while (queue.length && seen.size < cap) {
      const x = queue.shift();
      for (const dd in DIRS) { const n = stepCell(room, x, dd); if (n >= 0 && !seen.has(n) && !blocked(n)) { seen.add(n); queue.push(n); } }
    }
    // a head that could arrive on the same square next tick: dangerous unless we're clearly bigger
    // (teammates count too: heads crash whatever team they're on)
    const headRisk = others.some(q => !(q.fx.stone > now) && Object.keys(DIRS).some(dd => dd !== OPP[q.dir] && stepCell(room, q.body[0], dd) === c) && (!enemies.includes(q) || q.body.length >= p.body.length - 2));
    return { d, c, space: seen.size - 1, cap, headRisk, danger: danger.has(c) };
  });
  const alive = options.filter(o => !o.dead);

  // --- 4a. emergencies: nowhere safe to go, or boxed in ---
  const best = alive.reduce((m, o) => Math.max(m, o.space), 0);
  const trapped = !alive.length || best < Math.min(p.body.length, 12);
  if (trapped && p.items.length && (p.items[0] === 'ghost' || p.items[0] === 'stone') && Math.random() < 0.85) { A.useItem(room, p); return; }

  // --- 2 & 3. what to go for ---
  const targetDir = chooseTarget(room, p, A, st, enemies, blocked, now);

  // --- pick the move ---
  const hunting = st.huntUntil > now;
  // outside the coming shrink edge: getting back inside beats everything except not crashing
  const sb = room.shrink && room.shrink.bounds, hx = head % room.w, hy = Math.floor(head / room.w);
  const escaping = sb && (hx < sb.x0 || hx >= sb.x1 || hy < sb.y0 || hy >= sb.y1);
  let choice = null, top = -Infinity;
  for (const o of alive) {
    let score = o.space >= o.cap ? 60 : o.space * 60 / o.cap;   // open space matters most
    if (o.space < p.body.length) score -= 80;                       // likely a dead end
    if (o.headRisk) score -= hunting ? 15 : 45;                     // hunters are a bit reckless
    if (o.danger && !escaping) score -= 40;                         // bomb blast / outside the shrink
    if (o.d === targetDir) score += escaping ? 90 : 30;
    if (o.d === p.dir) score += 3;                                  // slight preference for going straight
    score += Math.random() * 12;                                    // imperfection
    if (score > top) { top = score; choice = o; }
  }
  // now and then a bot is a beat late and just carries on (only if straight ahead isn't a crash)
  if (Math.random() < 0.06 && options.some(o => o.d === p.dir && !o.dead)) choice = options.find(o => o.d === p.dir);
  if (choice && choice.d !== p.dir) p.queue.push(choice.d);

  // --- 4b. using items (with a short reaction delay) ---
  useItems(room, p, A, st, enemies, now);
}

// One breadth-first search from the head; every reached cell remembers the first move toward it. Returns
// the first move toward the best target (value / distance), or null.
function chooseTarget(room, p, A, st, enemies, blocked, now) {
  const head = p.body[0], first = new Map([[head, null]]), dist = new Map([[head, 0]]), queue = [head];
  while (queue.length && first.size < SEARCH_NODES) {
    const c = queue.shift();
    for (const d in DIRS) {
      if (c === head && d === OPP[p.dir]) continue;
      const n = stepCell(room, c, d);
      if (n < 0 || first.has(n) || blocked(n)) continue;
      first.set(n, c === head ? d : first.get(c)); dist.set(n, dist.get(c) + 1); queue.push(n);
    }
  }
  let bestDir = null, bestScore = 0;
  const consider = (c, value) => {
    if (!first.has(c) || c === head) return;
    const s = value / (dist.get(c) + 2);
    if (s > bestScore) { bestScore = s; bestDir = first.get(c); }
  };
  for (const c of room.food) consider(c, 10);
  for (const c of room.drops) consider(c, 10);
  for (const c of room.bits) consider(c, 5);
  for (const [c, sp] of room.specials) consider(c, sp.type === 'token' ? (room.teamMatch ? 35 : 0) : sp.type === 'feast' ? 30 : 22);
  for (const [c, t] of room.letters) consider(c, t.fruit ? 14 + 8 * ((p.fruit && p.fruit[t.fruit]) || 0) : 12);
  if (room.shrink) { // get inside the coming edge first
    const b = room.shrink.bounds, hx = head % room.w, hy = Math.floor(head / room.w);
    if (hx < b.x0 || hx >= b.x1 || hy < b.y0 || hy >= b.y1) { const cx = (b.x0 + b.x1) >> 1, cy = (b.y0 + b.y1) >> 1; consider(cy * room.w + cx, 400); }
  }
  // Pacman: enemy bodies are dinner
  if (p.fx.pacman > now) for (const q of enemies) if (!A.immune(q, now)) q.body.slice(1).forEach(c => consider(c, 30));
  // Hunting: now and then, if a nearby enemy is smaller, aim a few squares in front of its head
  if (now > st.nextHuntCheck) {
    st.nextHuntCheck = now + 5000 + rnd(8000);
    const prey = enemies.filter(q => !A.immune(q, now) && q.body.length < p.body.length * 1.1 && dist2(room, head, q.body[0]) < 400);
    if (prey.length && Math.random() < st.aggro) { st.huntId = prey[rnd(prey.length)].id; st.huntUntil = now + HUNT_MS; }
  }
  if (st.huntUntil > now) {
    const q = enemies.find(e => e.id === st.huntId);
    if (!q) st.huntUntil = 0;
    else { let c = q.body[0]; for (let i = 0; i < 3; i++) { const n = stepCell(room, c, q.dir); if (n < 0) break; c = n; } consider(c, 60); }
  }
  return bestDir;
}

function useItems(room, p, A, st, enemies, now) {
  const item = p.items[0];
  if (!item) { st.holdingSince = 0; return; }
  if (!st.holdingSince) st.holdingSince = now;
  if (now < st.itemReadyAt) return;
  const head = p.body[0], tail = p.body[p.body.length - 1];
  const near = (c, r) => enemies.some(q => q.body.some(b => dist2(room, b, c) <= r * r));
  const headNear = (c, r) => enemies.some(q => dist2(room, q.body[0], c) <= r * r);
  let use = false;
  if (item === 'pacman') use = near(head, 6);
  else if (item === 'blockade') use = p.body.length > 10 && headNear(tail, 7);      // trap someone behind us
  else if (item === 'poop') use = headNear(tail, 9);                                 // slow down a follower
  else if (item === 'bomb') use = p.body.length > 8 && near(tail, 4) && !near(head, 6);
  else if (item === 'stone') use = enemies.some(q => !(q.fx.ghost > now) && q.body[0] !== undefined && dist2(room, q.body[0], head) <= 4 && Math.random() < 0.5);
  // otherwise (ghost / stone kept for emergencies), a full hand gets used eventually
  if (!use && p.items.length >= 3 && now - st.holdingSince > 12000 && item !== 'ghost' && item !== 'stone') use = true;
  if (use) { A.useItem(room, p); st.holdingSince = 0; st.itemReadyAt = now + 600 + rnd(900); }
  else st.itemReadyAt = now + 150 + rnd(250); // a reaction delay before reconsidering
}

const BOT_NAMES = ['Rex', 'Mamba', 'Kaa', 'Viper', 'Noodle', 'Slinky', 'Fang', 'Ziggy', 'Boa', 'Monty', 'Hiss', 'Wiggles', 'Cobra', 'Sid'];

module.exports = { think, BOT_NAMES };
