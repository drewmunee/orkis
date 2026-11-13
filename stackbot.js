// Stackwar bots. Each bot is a server-side Stackwar player: it connects through a fake socket (so it uses
// exactly the same messages as a browser), keeps its own board with the same rules as public/game.js, and
// places pieces with a simple "try every placement and score the result" brain. Three difficulties:
//  easy:   places a piece every ~3 s, often makes poor or plain wrong placements, happy with singles and
//          doubles (the odd triple/tetris), fires specials at random people every few seconds.
//  medium: every ~1.5 s, builds for tetrises (keeps the right-hand column open, uses hold) and only takes
//          smaller clears when it has to; uses good specials on itself and bad ones on others as soon as it gets them.
//  insane: every ~0.75 s, builds tetrises, uses hold, rarely slips up, and is the only one that keeps up at
//          high levels; saves specials for when they hurt most (finishing someone off, hitting whoever is
//          doing best) or to rescue itself.
// Like a person, a bot that thinks slower than the piece falls doesn't get to finish its moves: the piece
// lands wherever it got to. Darkness and Inverted make them sloppy for a while; Haste makes pieces fall 3x faster.
const { EventEmitter } = require('events');

const W = 10, H = 23;
const PIECES = [ // same shapes and order as public/game.js (the shared queue depends on it)
  ['1', [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]]],
  ['2', [[1,1],[1,1]]],
  ['3', [[0,1,0],[1,1,1],[0,0,0]]],
  ['4', [[0,1,1],[1,1,0],[0,0,0]]],
  ['5', [[1,1,0],[0,1,1],[0,0,0]]],
  ['6', [[1,0,0],[1,1,1],[0,0,0]]],
  ['7', [[0,0,1],[1,1,1],[0,0,0]]],
];
const WEIGHTS = { A: 6, C: 6, R: 4, Q: 3, G: 1.5, B: 3, H: 3, D: 3, I: 3, S: 0.7, N: 0.7 }; // same as game.js
const SP_KEYS = Object.keys(WEIGHTS), BONUS_KEYS = SP_KEYS.filter(k => !'ACDH'.includes(k));
const MAX_INV = 5, COUNTDOWN_MS = 3000;
const HELPFUL = new Set(['C', 'N', 'G']);          // good for whoever gets them
const LEVELS = {
  // mistake: picks the 2nd..(1+spread)th best spot instead of the best; blunder: a random spot
  easy:   { placeMs: 3000, mistake: 0.25, spread: 3, blunder: 0.03, tetris: false, hold: false },
  medium: { placeMs: 1500, mistake: 0.07, spread: 2, blunder: 0.01, tetris: true,  hold: true },
  insane: { placeMs: 750,  mistake: 0.04, spread: 1, blunder: 0.003, tetris: true, hold: true },
};
const NAMES = ['Nova', 'Blocky', 'Tetra', 'Ziggy', 'Bolt', 'Pixel', 'Quad', 'Stax', 'Echo', 'Rook'];
const rnd = n => Math.floor(Math.random() * n);
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- the same rules as public/game.js ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeQueue(seed) {
  const r = mulberry32(seed); let bag = [];
  return { list: [], next() { while (this.list.length < 4) { if (!bag.length) { bag = [0,1,2,3,4,5,6]; for (let i = 6; i > 0; i--) { const j = (r() * (i + 1)) | 0; [bag[i], bag[j]] = [bag[j], bag[i]]; } } this.list.push(bag.pop()); } return this.list.shift(); } };
}
const emptyRow = () => Array(W).fill('.');
const newBoard = () => Array.from({ length: H }, emptyRow);
const serialize = b => b.map(r => r.join('')).join('');
const deserialize = s => { const b = newBoard(); if (s && s.length === W * H) for (let i = 0; i < W * H; i++) b[(i / W) | 0][i % W] = s[i]; return b; };
const rotate = m => m[0].map((_, i) => m.map(r => r[i]).reverse());
const isSpecial = c => WEIGHTS[c] !== undefined;
function collides(board, m, px, py) {
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
    if (!m[y][x]) continue;
    const bx = px + x, by = py + y;
    if (bx < 0 || bx >= W || by >= H) return true;
    if (by >= 0 && board[by][bx] !== '.') return true;
  }
  return false;
}
function randomSpecial(keys = SP_KEYS) {
  const total = keys.reduce((s, k) => s + WEIGHTS[k], 0);
  let r = Math.random() * total;
  for (const k of keys) { r -= WEIGHTS[k]; if (r < 0) return k; }
  return keys[0];
}
function garbageRow(withSpecials, chance = 0.7) {
  const row = Array(W).fill('8');
  row[rnd(W)] = '.';
  if (withSpecials && Math.random() < chance) {
    const count = Math.random() < 0.25 ? 2 : 1;
    for (let i = 0; i < count; i++) { const filled = row.map((c, x) => c === '8' ? x : -1).filter(x => x >= 0); row[filled[rnd(filled.length)]] = randomSpecial(); }
  }
  return row;
}
// column heights, holes and the tallest column of a board (also used to size up other players)
function shape(board) {
  const heights = [];
  let holes = 0;
  for (let x = 0; x < W; x++) {
    let y = 0; while (y < H && board[y][x] === '.') y++;
    heights.push(H - y);
    for (let yy = y + 1; yy < H; yy++) if (board[yy][x] === '.') holes++;
  }
  return { heights, holes, max: Math.max(...heights) };
}

// ---------- the placement brain ----------
// every reachable resting spot for a piece (each distinct rotation, each column), dropped straight down
function placements(board, idx) {
  const out = [], seen = new Set();
  let m = PIECES[idx][1];
  for (let rot = 0; rot < 4; rot++, m = rotate(m)) {
    const key = JSON.stringify(m); if (seen.has(key)) continue; seen.add(key);
    for (let x = -3; x < W; x++) {
      let y = PIECES[idx][0] === '1' ? -1 : 0;
      if (collides(board, m, x, y)) continue;
      while (!collides(board, m, x, y + 1)) y++;
      out.push({ idx, rot, m, x, y });
    }
  }
  return out;
}
function placeOn(board, p) {
  const b = board.map(r => r.slice());
  let over = false;
  p.m.forEach((r, y) => r.forEach((v, x) => { if (v) { const by = p.y + y; if (by < 0) over = true; else b[by][p.x + x] = PIECES[p.idx][0]; } }));
  let lines = 0;
  for (let y = H - 1; y >= 0; y--) if (b[y].every(c => c !== '.')) { b.splice(y, 1); b.unshift(emptyRow()); lines++; y++; }
  return { board: b, lines, over };
}
// How good is the board after this placement? Higher is better. Based on Pierre Dellacherie's classic
// hand-tuned evaluation (landing height, cleared cells, row/column transitions, holes, wells), plus
// each difficulty's taste in line clears. Tetris builders treat the right-hand column as a reserved well.
function features(board, cols) {
  let rowT = 0, colT = 0, holes = 0, wells = 0;
  for (let y = 0; y < H; y++) {
    let prev = true; // the wall counts as filled
    for (let x = 0; x < cols; x++) { const f = board[y][x] !== '.'; if (f !== prev) rowT++; prev = f; }
    if (!prev) rowT++;
  }
  for (let x = 0; x < cols; x++) {
    let prev = false, covered = false;
    for (let y = 0; y < H; y++) { const f = board[y][x] !== '.'; if (f !== prev) colT++; prev = f; if (f) covered = true; else if (covered) holes++; }
    if (!prev) colT++; // the floor counts as filled
    let depth = 0; // cumulative well depth: empty cells with filled (or wall) on both sides
    for (let y = 0; y < H; y++) {
      const filled = c => c < 0 || c >= cols || board[y][c] !== '.';
      if (board[y][x] === '.' && filled(x - 1) && filled(x + 1)) { depth++; wells += depth; } else if (board[y][x] !== '.') depth = 0; else depth = 0;
    }
  }
  return { rowT, colT, holes, wells };
}
function score(level, before, p, building) {
  const { board, lines, over } = placeOn(before, p);
  if (over) return -1e9;
  const cells = p.m.flat().filter(Boolean).length;
  const rows = p.m.map((r, i) => r.some(Boolean) ? i : -1).filter(i => i >= 0);
  const landing = H - (p.y + (rows[0] + rows[rows.length - 1]) / 2);
  const tallBefore = shape(before).max;
  const builder = (LEVELS[level].tetris || building) && tallBefore < 11; // under pressure everyone just survives
  const usesWell = p.m.some((r, y) => r.some((v, x) => v && p.x + x === W - 1));
  const f = features(board, builder ? W - 1 : W);
  const holes = builder ? features(board, W).holes : f.holes; // holes count everywhere, the well column included
  let s = -4.5 * landing + 3.42 * (lines * cells / 4) - 3.22 * f.rowT - 9.35 * f.colT - 7.9 * holes - 3.39 * f.wells;
  if (!builder) s += [0, 8, 18, 30, 45][lines];               // any clear is welcome (easy likes singles/doubles)
  else {
    s += [0, -18, -14, -8, 90][lines];                         // hold out for tetrises
    if (usesWell && lines < 4) s -= 70;                        // don't plug the well
  }
  return s;
}

class StackBot {
  constructor(level, name, connect) {
    this.level = LEVELS[level] ? level : 'medium';
    this.cfg = LEVELS[this.level];
    this.name = name;
    this.players = []; this.boards = new Map();
    this.playing = false; this.alive = false;
    this.ws = new BotSocket(this);
    connect(this.ws);
    this.timer = setInterval(() => this.tick(), 50);
  }
  send(m) { if (this.ws.readyState === 1) this.ws.emit('message', JSON.stringify(m)); }
  stop() { clearInterval(this.timer); this.playing = false; }

  // ---- messages from the server (same ones a browser gets) ----
  receive(m) {
    switch (m.t) {
      case 'welcome': this.id = m.id; break;
      case 'lobby': this.players = m.players; break;
      case 'start': this.players = m.players; this.start(m.seed); break;
      case 'board': this.boards.set(m.id, m.cells); break;
      case 'dead': { const p = this.players.find(q => q.id === m.id); if (p) p.alive = false; break; }
      case 'gameover': this.playing = false; break;
      case 'garbage': if (this.playing) { this.addGarbage(m.count, true, m.rich ? 0.95 : 0.7); this.dirty = true; } break;
      case 'special': if (this.playing) this.applySpecial(m.special); break;
      case 'setboard': if (this.playing) { this.board = deserialize(m.cells); this.dirty = true; } break;
      case 'bonus': if (this.playing) this.collect([randomSpecial(BONUS_KEYS)]); break;
    }
  }
  start(seed) {
    this.board = newBoard(); this.queue = makeQueue(seed); this.inventory = []; this.lines = 0;
    this.held = null; this.hasteUntil = 0; this.darkUntil = 0; this.invertUntil = 0;
    this.playing = true; this.alive = true; this.boards.clear(); this.building = false; this.streakLeft = 10 + rnd(20);
    this.goAt = Date.now() + COUNTDOWN_MS; this.nextSpecialAt = this.goAt + rand(2000, 5000);
    this.spawn(this.queue.next(), this.goAt);
    this.send({ t: 'board', cells: serialize(this.board) });
  }
  get levelNum() { return 1 + Math.floor(this.lines / 10); }
  gravityMs(now) { let ms = Math.max(70, 800 - (this.levelNum - 1) * 70); if (now < this.hasteUntil) ms /= 3; return ms; }
  spawn(idx, at = Date.now()) {
    this.piece = { idx, born: at };
    this.holdUsed = false;
    // how long this bot "thinks" before the piece is placed (varies around its average)
    this.placeAt = at + this.cfg.placeMs * rand(0.55, 1.45);
    const m = PIECES[idx][1], x = ((W - m[0].length) / 2) | 0, y = PIECES[idx][0] === '1' ? -1 : 0;
    if (collides(this.board, m, x, y)) this.die();
  }
  die() {
    if (!this.alive) return;
    this.alive = false; this.playing = false;
    this.board = this.board.map(r => r.map(c => c === '.' ? '.' : '8'));
    this.send({ t: 'board', cells: serialize(this.board) });
    this.send({ t: 'dead' });
  }
  addGarbage(count, withSpecials, chance) {
    for (let i = 0; i < count; i++) {
      const top = this.board.shift();
      if (top.some(c => c !== '.')) { this.board.unshift(top); return this.die(); }
      this.board.push(garbageRow(withSpecials, chance));
    }
  }
  collect(got) { this.inventory.push(...got); if (this.inventory.length > MAX_INV) this.inventory.splice(0, this.inventory.length - MAX_INV); }
  applySpecial(s) {
    const now = Date.now(), b = this.board;
    switch (s) {
      case 'A': this.addGarbage(1, false); break;
      case 'C': b.pop(); b.unshift(emptyRow()); break;
      case 'N': this.board = newBoard(); break;
      case 'R': { const f = []; b.forEach((r, y) => r.forEach((c, x) => c !== '.' && f.push([x, y]))); for (let i = 0; i < 8 && f.length; i++) { const [x, y] = f.splice(rnd(f.length), 1)[0]; b[y][x] = '.'; } break; }
      case 'Q': this.board = b.map(r => { const k = rnd(5) - 2; return r.map((_, x) => r[(x - k + W) % W]); }); break;
      case 'G': for (let x = 0; x < W; x++) { const col = []; for (let y = 0; y < H; y++) if (b[y][x] !== '.') col.push(b[y][x]); for (let y = H - 1; y >= 0; y--) b[y][x] = col.length ? col.pop() : '.'; }
        for (let y = H - 1; y >= 0; y--) if (b[y].every(c => c !== '.')) { b.splice(y, 1); b.unshift(emptyRow()); y++; } break;
      case 'B': { const sp = []; b.forEach((r, y) => r.forEach((c, x) => isSpecial(c) && sp.push([x, y]))); for (let i = 0; i < 3 && sp.length; i++) { const [x, y] = sp.splice(rnd(sp.length), 1)[0]; b[y][x] = '8'; } break; }
      case 'H': this.hasteUntil = Math.max(this.hasteUntil, now) + 10000; break;
      case 'D': this.darkUntil = Math.max(this.darkUntil, now) + 4000; break;
      case 'I': this.invertUntil = Math.max(this.invertUntil, now) + 5000; break;
    }
    this.dirty = true;
  }

  // ---- every 50 ms: place the piece when it's time, use specials, keep the others updated ----
  tick() {
    const now = Date.now();
    if (this.playing && now >= this.goAt) {
      if (now >= this.placeAt) this.place(now);
      if (this.playing) this.useSpecials(now);
    }
    if (this.dirty && this.playing && now - (this.sentAt || 0) > 120) { this.dirty = false; this.sentAt = now; this.send({ t: 'board', cells: serialize(this.board) }); }
  }
  place(now) {
    const cfg = this.cfg;
    // easy bots now and then try building for a big clear for a while (the odd triple / tetris)
    if (this.level === 'easy' && --this.streakLeft <= 0) { this.building = Math.random() < 0.3; this.streakLeft = 15 + rnd(25); }
    // pick a piece: the current one, or (insane, once per piece) swap with the saved one if that's better
    let options = placements(this.board, this.piece.idx).map(p => ({ ...p, s: score(this.level, this.board, p, this.building) }));
    if (cfg.hold && !this.holdUsed) {
      const alt = this.held !== null ? this.held : this.queue.list[0];
      const altOpts = placements(this.board, alt).map(p => ({ ...p, s: score(this.level, this.board, p, this.building), hold: true }));
      const bestAlt = Math.max(-Infinity, ...altOpts.map(o => o.s)), best = Math.max(-Infinity, ...options.map(o => o.s));
      if (bestAlt > best + 3) {
        const cur = this.piece.idx;
        this.piece.idx = this.held !== null ? this.held : this.queue.next();
        this.held = cur; this.holdUsed = true;
        options = altOpts;
      }
    }
    if (!options.length) return this.die();
    options.sort((a, b) => b.s - a.s);
    // mistakes: sloppier in the dark or with scrambled controls
    let mistake = cfg.mistake, blunder = cfg.blunder;
    if (now < this.darkUntil) { mistake += this.level === 'insane' ? 0.15 : 0.4; blunder += 0.05; }
    if (now < this.invertUntil) { mistake += this.level === 'insane' ? 0.2 : 0.5; blunder += 0.08; }
    let pick = options[0];
    if (Math.random() < blunder) pick = options[rnd(options.length)];
    else if (Math.random() < mistake) pick = options[Math.min(options.length - 1, 1 + rnd(cfg.spread))];
    // too slow for the falling piece? it lands wherever the bot had got it to
    const g = this.gravityMs(now), spawnX = ((W - PIECES[pick.idx][1][0].length) / 2) | 0;
    let depth = 0; { const m0 = PIECES[pick.idx][1]; let y = PIECES[pick.idx][0] === '1' ? -1 : 0; while (!collides(this.board, m0, spawnX, y + 1)) { y++; depth++; } }
    const timeToLand = depth * g + 500; // fall + lock delay
    const thought = now - this.piece.born;
    if (thought > timeToLand) {
      const f = Math.max(0, Math.min(1, timeToLand / thought)); // how much of the plan got done
      const x = Math.round(spawnX + (pick.x - spawnX) * f);
      let m = PIECES[pick.idx][1]; if (f > 0.4) m = pick.m;
      if (!collides(this.board, m, x, PIECES[pick.idx][0] === '1' ? -1 : 0)) {
        let y = PIECES[pick.idx][0] === '1' ? -1 : 0; while (!collides(this.board, m, x, y + 1)) y++;
        pick = { idx: pick.idx, m, x, y };
      }
    }
    this.lock(pick);
  }
  lock(p) {
    let over = false;
    p.m.forEach((r, y) => r.forEach((v, x) => { if (v) { const by = p.y + y; if (by < 0) over = true; else this.board[by][p.x + x] = PIECES[p.idx][0]; } }));
    if (over) return this.die();
    let n = 0; const got = [];
    for (let y = H - 1; y >= 0; y--) if (this.board[y].every(c => c !== '.')) { for (const c of this.board[y]) if (isSpecial(c)) got.push(c); this.board.splice(y, 1); this.board.unshift(emptyRow()); n++; y++; }
    if (n) {
      // a 3- or 4-line clear collects each special twice, like for people
      this.collect(got.flatMap(c => n >= 3 ? [c, c] : [c]));
      this.lines += n;
      this.send({ t: 'lines', count: n });
    }
    this.dirty = true;
    if (this.playing) this.spawn(this.queue.next());
  }

  // ---- specials: only the oldest one in the hand can be fired (same as people) ----
  useSpecials(now) {
    if (!this.inventory.length || now < this.nextSpecialAt) return;
    const me = this.players.find(p => p.id === this.id);
    const alive = this.players.filter(p => p.alive);
    const foes = alive.filter(p => p.id !== this.id && !(me && me.team && p.team === me.team));
    const s = this.inventory[0];
    const fire = target => { this.inventory.shift(); this.send({ t: 'special', special: s, slot: target.slot }); this.nextSpecialAt = now + this.reaction(); };
    const skip = () => { this.inventory.shift(); this.nextSpecialAt = now + this.reaction(); }; // discard it
    if (!me) return;
    if (this.level === 'easy') { // random: anyone (including itself), every few seconds
      this.nextSpecialAt = now + rand(3000, 8000);
      return fire(alive[rnd(alive.length)] || me);
    }
    const mine = shape(this.board);
    const sized = foes.map(p => ({ p, ...shape(deserialize(this.boards.get(p.id) || '')), specials: [...(this.boards.get(p.id) || '')].filter(isSpecial).length }));
    if (this.level === 'medium') { // as soon as it gets them: good ones on itself, bad ones on a random opponent
      if (HELPFUL.has(s)) return fire(me);
      if (s === 'S') { const low = sized.filter(f => f.max < mine.max - 3).sort((a, b) => a.max - b.max)[0]; return low ? fire(low.p) : skip(); }
      return foes.length ? fire(foes[rnd(foes.length)]) : skip();
    }
    // insane: save itself when it needs to, otherwise strike where it hurts most
    const danger = mine.max >= 13;
    if (HELPFUL.has(s)) {
      const need = danger || (s === 'G' && mine.holes >= 4) || (s === 'C' && mine.max >= 9);
      if (need || this.inventory.length >= MAX_INV) return fire(me);
      if (s === 'N' && mine.max < 9 && this.inventory.length < MAX_INV) return; // keep the nuke for an emergency
      return this.inventory.length >= 3 ? fire(me) : undefined;
    }
    if (s === 'S') { // trade boards with whoever has the best one, but only when ours is clearly worse
      const best = sized.sort((a, b) => a.max - b.max)[0];
      return best && best.max < mine.max - 4 ? fire(best.p) : (this.inventory.length >= 3 ? skip() : undefined);
    }
    if (s === 'R' && danger) return fire(me); // knock blocks out of its own tall stack
    if (!sized.length) return skip();
    // who to hit: someone close to topping out (finish them), else whoever is doing best (lowest stack);
    // Blank goes to whoever has the most specials on their board
    const finish = sized.filter(f => f.max >= 15).sort((a, b) => b.max - a.max)[0];
    let target;
    if (s === 'B') target = sized.sort((a, b) => b.specials - a.specials)[0];
    else target = finish || sized.sort((a, b) => a.max - b.max)[0];
    const worthIt = finish || s === 'B' && target.specials >= 2 || target.max >= 9 || this.inventory.length >= 3 || 'HDI'.includes(s);
    if (worthIt) return fire(target.p);
    this.nextSpecialAt = now + 400;
  }
  reaction() { return { easy: rand(2500, 6000), medium: rand(500, 1500), insane: rand(250, 700) }[this.level]; }
}

// A pretend WebSocket: server.js treats it like any other connection. What the server sends is handed to the
// bot (a tick later, so a bot never reacts in the middle of the server handling something else).
class BotSocket extends EventEmitter {
  constructor(bot) { super(); this.bot = bot; this.readyState = 1; this.isBot = true; }
  send(s) { if (this.readyState !== 1) return; setImmediate(() => { if (this.readyState === 1) this.bot.receive(JSON.parse(s)); }); }
  ping() {}
  close() { this.terminate(); }
  terminate() { if (this.readyState !== 1) return; this.readyState = 3; this.bot.stop(); this.emit('close'); }
}

// addBot(roomCode, level, takenNames, connect): connect(fakeSocket) hands the socket to the server's
// connection handler; the bot then joins like a browser would.
function addBot(roomCode, level, taken, connect) {
  const lv = LEVELS[level] ? level : 'medium';
  const used = new Set([...taken].map(n => n.toLowerCase()));
  const name = 'Bot ' + (NAMES.find(n => !used.has(('bot ' + n).toLowerCase())) || rnd(100));
  const bot = new StackBot(lv, name, connect);
  bot.send({ t: 'join', name, room: roomCode, bot: lv });
  return bot;
}

module.exports = { addBot, LEVELS, _internals: { placements, score, shape, StackBot, deserialize, makeQueue, PIECES } };
