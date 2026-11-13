// Blockwar client. Your own game runs here (physics, blocks, specials); the server starts matches,
// relays board snapshots (about 4 a second) and specials, and decides who wins.
(() => {
const $ = id => document.getElementById(id);
const W = 800, H = 600;                         // logical board size (4:3), scaled to fit
const COLS = 12, ROWS = 18, TOP = 40, BH = 24;  // block grid; rows below the starting 8 fill up in solo / from Random
const BW = W / COLS, START_ROWS = 8;
// one calm sunset gradient (deep plum at the top through rose to warm orange at the bottom), so the
// brightly colored special blocks still stand out
const ROW_COLORS = ['#4a3470', '#5d3a7c', '#743f84', '#8c4686', '#a44f80', '#ba5b73', '#cc6d62', '#da834f'];
const STONE = '#8d8478', CRACKED = '#6b645b'; // stone takes two hits: the first cracks it (darker)
const PADDLE_W = 110, PADDLE_H = 14, PADDLE_Y = H - 40, PADDLE_SPEED = 640;
const BALL_R = 8, START_SPEED = 380, SPEED_UP = 3, SOLO_SPEED_UP = 1.5, MAX_SPEED = 700; // solo speeds up more gently
const MAX_ANGLE = Math.PI / 3;                  // paddle edge sends the ball out at 60° from straight up
const START_LIVES = 3, RESPAWN_MS = 5000, FX_MS = 10000, BOOM_MS = 5000, ENDING_MS = 3000, QUEUE_MAX = 3, SPECIAL_RATE = 0.07;
const SYNC_MS = 250;                            // how often your board is sent to the others
// Specials (letter blocks you break to collect): [name, color, description, weight]
const SPECIALS = {
  A: ['Add Line', '#ff5470', 'pushes the target\'s blocks down and adds 2 new rows on top (multiplayer only)', 3],
  R: ['Random', '#b08968', 'drops a boulder or stalactite of breakable stone onto the board', 4],
  C: ['Clear Line', '#7bffb0', 'instantly removes the lowest row of blocks', 3],
  M: ['Multiball', '#ffd23f', 'doubles the number of balls, triples in solo (a life is only lost when every ball is gone)', 3],
  S: ['Slow Ball', '#a0c4ff', 'halves ball speed for 10 seconds (20 in solo)', 3],
  F: ['Fast Ball', '#ff7b7b', 'doubles ball speed for 10 seconds', 3],
  B: ['Big Paddle', '#4cde6c', 'doubles paddle width for 10 seconds (20 in solo)', 3],
  T: ['Tiny Paddle', '#ff9a3c', 'halves paddle width for 10 seconds', 3],
  Q: ['Earthquake', '#c8a2ff', 'shuffles the board, buries its specials away from the edge, and shakes a few blocks down a row or two', 2],
  E: ['Explosivo', '#ff5aa0', 'for 5 seconds (10 in solo) every block the ball breaks also breaks the blocks touching its sides', 2],
};
const SP_KEYS = Object.keys(SPECIALS);
const SLOT_COLORS = ['', '#ff5470', '#30d5ff', '#4cde6c', '#ffd23f', '#b45cff', '#ff9a3c'];

let name = '';
try { name = localStorage.getItem('sw-name') || ''; } catch {}
const roomCode = new URLSearchParams(location.search).get('room') || 'lobby';
if (!name.trim()) { location.replace('/'); return; }

// ---------- state ----------
let ws, myId = null, hostId = null, roomState = 'lobby', lobbyMode = 'clear', players = [];
const others = new Map();     // id -> latest board snapshot
let mode = null;              // this match: 'solo' | 'clear' | 'lives' (null between matches)
let playing = false;          // my game is running
let brokenCount = 0, livesLost = 0; // running totals for this match (for stats)
let grid, balls = [], paddleX, lives, score = 0, level = 1, brokenSinceRow, rowsAdded, phase, phaseUntil, pendingBalls, ballSpeed;
let soloResult = '';      // leaderboard line after a solo run
let queue = [], fx = {};  // held specials and active effects (start empty so drawing works before the first match)
// phase: 'ready' (ball on paddle, Space to launch) | 'play' | 'wait' (5 s after losing a life) | 'done'
const keys = new Set();
const canvas = $('board'), ctx = canvas.getContext('2d');
let theme = {};
function readTheme() { const cs = getComputedStyle(document.documentElement); theme = { well: cs.getPropertyValue('--well').trim(), text: cs.getPropertyValue('--text').trim(), dim: cs.getPropertyValue('--dim').trim() }; drawOpps(); }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const badge = (n, big) => `<span class="slot${big ? ' big' : ''}" style="background:${SLOT_COLORS[n]}">${n}</span>`;
// numbers are per viewer: you are always 1, everyone else 2, 3, ... in join order
const ordered = () => [...players.filter(p => p.id === myId), ...players.filter(p => p.id !== myId).sort((a, b) => a.slot - b.slot)];
const numOf = p => ordered().indexOf(p) + 1;
const nameOf = id => (players.find(p => p.id === id) || {}).name || '?';

// ---------- seeded random (clear races start on the same board) ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// Solo runs never spawn Add Line, Random (stone), Tiny Paddle, Fast Ball or Earthquake blocks; multiplayer gets them all.
const SOLO_EXCLUDED = 'ARTFQ';
function pickSpecial(rand = Math.random) {
  const keys = mode === 'solo' ? SP_KEYS.filter(k => !SOLO_EXCLUDED.includes(k)) : SP_KEYS;
  const total = keys.reduce((s, k) => s + SPECIALS[k][3], 0);
  let r = rand() * total;
  for (const k of keys) { r -= SPECIALS[k][3]; if (r < 0) return k; }
  return SP_KEYS[0];
}

// ---------- the grid: '.' empty, 'a'-'h' colored block (by row), 'z' stone, 'y' cracked stone, uppercase = special ----------
const idx = (r, c) => r * COLS + c;
// rockRate: chance each block is stone instead (solo rows from level 2 on)
function makeRow(r, rand, rockRate = 0) { const row = []; for (let c = 0; c < COLS; c++) row.push(rand() < SPECIAL_RATE ? pickSpecial(rand) : rand() < rockRate ? 'z' : 'abcdefgh'[r % 8]); return row; }
// Solo: no stone at level 1; from level 2 each new block has a 6% chance to be stone, +3% per level, max 30%
const soloRockRate = () => level < 2 ? 0 : Math.min(0.3, 0.06 + 0.03 * (level - 2));
function newGrid(seed) {
  const rand = mulberry32(seed);
  grid = Array(ROWS * COLS).fill('.');
  for (let r = 0; r < START_ROWS; r++) makeRow(r, rand).forEach((ch, c) => { grid[idx(r, c)] = ch; });
}
const blocksLeft = () => grid.reduce((n, ch) => n + (ch !== '.'), 0);
const cellColor = ch => ch === 'z' ? STONE : ch === 'y' ? CRACKED : ch >= 'a' && ch <= 'h' ? ROW_COLORS[ch.charCodeAt(0) - 97] : (SPECIALS[ch] || [0, '#888'])[1];

// ---------- match flow ----------
function startMatch(seed, m) {
  mode = m; playing = true; soloResult = ''; brokenCount = 0; livesLost = 0;
  newGrid(seed);
  lives = START_LIVES; score = 0; level = 1; brokenSinceRow = 0; rowsAdded = 0; rowsReceived = 0; queue = []; fx = {}; pendingBalls = 1; ballSpeed = START_SPEED; speedLevel = 1;
  toReady();
  $('levelStat').classList.toggle('hidden', mode !== 'solo');
  renderQueue(); updateHud(); sync(true);
}
function toReady() { paddleX = (W - paddleW()) / 2; balls = []; phase = 'ready'; } // paddle back to the middle, ball on it
function launch() {
  // a random direction up and away from the paddle; Multiball picked up while waiting launches extra balls
  const n = Math.max(1, pendingBalls);
  for (let i = 0; i < n; i++) {
    const a = (Math.random() * 2 - 1) * MAX_ANGLE;
    balls.push({ x: paddleX + paddleW() / 2, y: PADDLE_Y - BALL_R - 1, vx: Math.sin(a), vy: -Math.cos(a) });
  }
  pendingBalls = 1; phase = 'play';
}
function gameOver(why) {
  phase = 'done'; playing = false; balls = [];
  sync(true); // final board (and stat totals) before saying we're out
  net({ t: 'out', score, level });
  setStatus(mode === 'solo' ? `${why ? why + ' ' : ''}Game over: ${score} points (level ${level})` : 'Out of lives!');
  updateHud(); sync(true);
}
function loseLife() {
  // clear races never run out of lives; lives mode and solo do
  livesLost++;
  // the ball starts at its starting speed again; the level carries on, and only levels gained from
  // here on speed it up again
  ballSpeed = START_SPEED; speedLevel = level;
  if (mode !== 'clear') lives--;
  updateHud();
  if (mode !== 'clear' && lives <= 0) return gameOver();
  // solo: straight back on the paddle, launch whenever you're ready; multiplayer waits 5 s
  if (mode === 'solo') return toReady();
  phase = 'wait'; phaseUntil = performance.now() + RESPAWN_MS; balls = [];
}
function boardCleared() {
  if (mode === 'clear') { phase = 'done'; playing = false; sync(true); net({ t: 'cleared' }); return; }
  // lives mode: a fresh board; solo: rows keep coming anyway
  newGrid((Math.random() * 2 ** 31) | 0);
}

// Solo: every row's worth of blocks broken brings a new row in at the top; every 5 rows the level
// (and ball speed) goes up. If the blocks reach the bottom row, it's over.
function soloProgress() {
  if (mode !== 'solo' || ++brokenSinceRow < COLS) return;
  brokenSinceRow = 0;
  if (grid.slice(idx(ROWS - 1, 0)).some(ch => ch !== '.')) return gameOver('The blocks reached the bottom!');
  grid.splice(idx(ROWS - 1, 0), COLS);
  grid.unshift(...makeRow(START_ROWS + rowsAdded, Math.random, soloRockRate()));
  rowsAdded++; level = 1 + Math.floor(rowsAdded / 5);
  updateHud();
}
let speedLevel = 1; // the level the current speed-up started from (reset when a life is lost)
const levelMul = () => mode === 'solo' ? 1 + 0.05 * (level - speedLevel) : 1; // +5% ball speed per level

// ---------- effects from specials ----------
const now = () => performance.now();
const paddleW = () => PADDLE_W * (fx.paddle && fx.paddle.until > now() ? fx.paddle.mul : 1);
const speedMul = () => (fx.speed && fx.speed.until > now() ? fx.speed.mul : 1) * levelMul();
// solo: timed specials last twice as long (Explosivo 10 s instead of 5)
const fxMs = () => mode === 'solo' ? FX_MS * 2 : FX_MS, boomMs = () => mode === 'solo' ? 10000 : BOOM_MS;
const stackFx = (cur, mul, ms = fxMs()) => ({ mul, until: (cur && cur.mul === mul && cur.until > now() ? cur.until : now()) + ms });
const exploding = () => !!(fx.boom && fx.boom.until > now());
function applySpecial(s) {
  if (!playing) return;
  switch (s) {
    case 'A': addRows(2); break;
    case 'R': addRock(); break;
    case 'C': { // lowest row with anything in it; its blocks score as if you'd broken them
      for (let r = ROWS - 1; r >= 0; r--) if (grid.slice(idx(r, 0), idx(r, COLS)).some(ch => ch !== '.')) {
        for (let c = 0; c < COLS; c++) { const ch = grid[idx(r, c)]; if (ch !== '.') { score += ch === 'z' || ch === 'y' ? 5 : 10; brokenCount++; } grid[idx(r, c)] = '.'; }
        break;
      }
      if (!blocksLeft()) boardCleared();
      break;
    }
    case 'M': { // every ball splits in two (three in solo), the new ones heading off at other angles
      const n = mode === 'solo' ? 3 : 2;
      if (phase === 'play') balls = balls.flatMap(b => {
        const out = [b];
        if (n === 2) out.push({ ...b, vx: -b.vx || 0.3 });
        else for (const d of [-0.5, 0.5]) { const a = Math.atan2(b.vx, -b.vy) + d; out.push({ ...b, vx: Math.sin(a), vy: -Math.abs(Math.cos(a)) || -0.5 }); }
        return out;
      });
      else pendingBalls *= n;
      break;
    }
    // the same effect again stacks (adds 10 s to what's left); the opposite one replaces it
    case 'S': fx.speed = stackFx(fx.speed, 0.5); break;
    case 'F': fx.speed = stackFx(fx.speed, 2); break;
    case 'B': fx.paddle = stackFx(fx.paddle, 2); break;
    case 'T': fx.paddle = stackFx(fx.paddle, 0.5); break;
    case 'Q': earthquake(); break;
    case 'E': fx.boom = stackFx(fx.boom, 1, boomMs()); break; // stacks like every timed special
  }
  updateHud(); sync(true);
}
// Random: a lump of stone blocks that makes clearing awkward - a round boulder in open space, or a
// stalactite hanging from the bottom of the blocks
function addRock() {
  const free = (r, c) => r >= 0 && r < ROWS - 2 && c >= 0 && c < COLS && grid[idx(r, c)] === '.';
  if (Math.random() < 0.5) {
    for (let tries = 0; tries < 40; tries++) {
      const r0 = 3 + ((Math.random() * (ROWS - 7)) | 0), c0 = 1 + ((Math.random() * (COLS - 2)) | 0);
      const cells = [];
      for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) if (Math.abs(r - r0) + Math.abs(c - c0) <= 1 || Math.random() < 0.6) cells.push([r, c]);
      const ok = cells.filter(([r, c]) => free(r, c));
      if (ok.length >= 4) { for (const [r, c] of ok) grid[idx(r, c)] = 'z'; return; }
    }
  }
  // stalactite: 1-2 columns wide, 3-6 long, from just under the lowest block in that column
  const c0 = (Math.random() * (COLS - 1)) | 0, wide = Math.random() < 0.5 ? 2 : 1, len = 3 + ((Math.random() * 4) | 0);
  for (let c = c0; c < c0 + wide; c++) {
    let r = 0; for (let k = 0; k < ROWS; k++) if (grid[idx(k, c)] !== '.') r = k + 1;
    for (let i = 0; i < len; i++) if (free(r + i, c)) grid[idx(r + i, c)] = 'z';
  }
}
// Earthquake: shuffle what's in every filled square, then bury specials: any special left on the
// outermost layer (a square the ball can reach from below) swaps with a plain block further in
function earthquake() {
  const filled = []; grid.forEach((ch, i) => { if (ch !== '.') filled.push(i); });
  const contents = filled.map(i => grid[i]);
  for (let i = contents.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [contents[i], contents[j]] = [contents[j], contents[i]]; }
  filled.forEach((i, k) => { grid[i] = contents[k]; });
  const exposed = i => { const r = (i / COLS) | 0; return r === ROWS - 1 || grid[i + COLS] === '.'; };
  const inner = filled.filter(i => !exposed(i) && !SPECIALS[grid[i]]);
  for (const i of filled) if (exposed(i) && SPECIALS[grid[i]] && inner.length) {
    const j = inner.splice((Math.random() * inner.length) | 0, 1)[0]; [grid[i], grid[j]] = [grid[j], grid[i]];
  }
  // then the shaking knocks a few loose: 4-6 blocks with open space under them fall 1-2 rows toward the
  // paddle (never into the bottom two rows)
  const loose = [];
  grid.forEach((ch, i) => { const r = (i / COLS) | 0; if (ch !== '.' && r < ROWS - 3 && grid[i + COLS] === '.') loose.push(i); });
  for (let n = 4 + ((Math.random() * 3) | 0); n > 0 && loose.length; n--) {
    const i = loose.splice((Math.random() * loose.length) | 0, 1)[0];
    if (grid[i] === '.' || grid[i + COLS] !== '.') continue; // something already moved here
    let to = i + COLS;
    if (Math.random() < 0.5 && ((to / COLS) | 0) < ROWS - 3 && grid[to + COLS] === '.') to += COLS;
    grid[to] = grid[i]; grid[i] = '.';
  }
}
// Multiplayer attacks (Add Line, and a row for every 24 blocks an opponent breaks): everything moves down
// and new rows come in at the top. Blocks never get pushed past the bottom row: a board already full to
// the bottom takes no more rows.
let rowsReceived = 0;
function addRows(n) {
  if (!playing || phase === 'done') return;
  for (let k = 0; k < n; k++) {
    if (grid.slice(idx(ROWS - 1, 0)).some(ch => ch !== '.')) break;
    grid.splice(idx(ROWS - 1, 0), COLS);
    grid.unshift(...makeRow(START_ROWS + rowsReceived++, Math.random));
  }
  updateHud(); sync(true);
}
function useSpecial(num) {
  if (!playing || !queue.length) return;
  const target = ordered()[num - 1];
  if (!target || !target.alive) return;
  net({ t: 'special', special: queue.shift(), slot: target.slot });
  renderQueue();
}

// ---------- physics ----------
// The paddle is drawn flat but bounces like a half circle: where the ball lands decides where it goes.
function bounceOffPaddle(b) {
  const pw = paddleW(), off = Math.max(-1, Math.min(1, (b.x - (paddleX + pw / 2)) / (pw / 2 + BALL_R)));
  const a = off * MAX_ANGLE;
  b.vx = Math.sin(a); b.vy = -Math.cos(a); b.y = PADDLE_Y - BALL_R - 0.5;
}
// Break the block the ball overlaps most, bounce off the side it hit, collect specials
function hitBlocks(b) {
  const r0 = Math.max(0, Math.floor((b.y - BALL_R - TOP) / BH)), r1 = Math.min(ROWS - 1, Math.floor((b.y + BALL_R - TOP) / BH));
  const c0 = Math.max(0, Math.floor((b.x - BALL_R) / BW)), c1 = Math.min(COLS - 1, Math.floor((b.x + BALL_R) / BW));
  let best = -1, bestD = Infinity, bn = null;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    if (grid[idx(r, c)] === '.') continue;
    const x = c * BW, y = TOP + r * BH;
    const nx = Math.max(x, Math.min(b.x, x + BW)), ny = Math.max(y, Math.min(b.y, y + BH));
    const dx = b.x - nx, dy = b.y - ny, d = dx * dx + dy * dy;
    if (d < BALL_R * BALL_R && d < bestD) { best = idx(r, c); bestD = d; bn = [dx, dy]; }
  }
  if (best < 0) return;
  let n = breakCell(best) ? 1 : 0;
  // Explosivo: the blocks touching the broken one's four sides go too (no chain reaction)
  if (exploding()) {
    const r = (best / COLS) | 0, c = best % COLS;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && grid[idx(rr, cc)] !== '.' && breakCell(idx(rr, cc))) n++;
    }
  }
  ballSpeed = Math.min(MAX_SPEED, ballSpeed + (mode === 'solo' ? SOLO_SPEED_UP : SPEED_UP));
  let [dx, dy] = bn;
  if (dx === 0 && dy === 0) { dx = -b.vx; dy = -b.vy; }
  if (Math.abs(dx) > Math.abs(dy)) { if (Math.sign(b.vx) !== Math.sign(dx)) b.vx = -b.vx; }
  else if (Math.sign(b.vy) !== Math.sign(dy)) b.vy = -b.vy;
  // solo rows move the whole grid down, so they only come in once every break above is done
  for (let k = 0; k < n && phase !== 'done'; k++) soloProgress();
  if (phase === 'done') return;
  if (!blocksLeft()) boardCleared();
  updateHud();
}
// a ball hits a block: stone cracks on the first hit (5 points) and breaks on the second (5 more);
// anything else breaks, scores, counts and gives its special. Returns true if the block is gone.
function breakCell(i) {
  const ch = grid[i];
  if (ch === 'z') { grid[i] = 'y'; score += 5; return false; }
  grid[i] = '.'; brokenCount++;
  if (SPECIALS[ch]) { queue.push(ch); if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX); renderQueue(); }
  score += ch === 'y' ? 5 : 10;
  return true;
}
function update(dt) {
  const dir = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  if (playing && phase !== 'done') paddleX = Math.max(0, Math.min(W - paddleW(), paddleX + dir * PADDLE_SPEED * dt));
  if (!playing) return;
  if (paddleX > W - paddleW()) paddleX = W - paddleW(); // a paddle that just grew stays on the board
  if (phase === 'wait' && now() >= phaseUntil) toReady();
  if (phase !== 'play') return;
  const speed = ballSpeed * speedMul();
  const steps = Math.ceil(speed * dt / (BALL_R * 0.5));
  for (let i = 0; i < steps && phase === 'play'; i++) {
    for (const b of balls) {
      const n = Math.hypot(b.vx, b.vy) || 1; b.vx /= n; b.vy /= n;
      b.x += b.vx * speed * dt / steps; b.y += b.vy * speed * dt / steps;
      if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
      if (b.x > W - BALL_R) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
      if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
      if (b.vy > 0 && b.y + BALL_R >= PADDLE_Y && b.y - BALL_R <= PADDLE_Y + PADDLE_H && b.x >= paddleX - BALL_R && b.x <= paddleX + paddleW() + BALL_R) bounceOffPaddle(b);
      if (phase === 'play') hitBlocks(b);
    }
    // a ball that falls off the bottom is gone; only when every ball is gone do you lose a life
    balls = balls.filter(b => b.y - BALL_R <= H);
    if (!balls.length && phase === 'play') loseLife();
  }
}

// ---------- drawing ----------
function drawBoard(cx, s, { cells, px, pw, balls: bs, ready, scale = 1, paddleAlpha = 1 }) {
  cx.fillStyle = theme.well; cx.fillRect(0, 0, W, H);
  for (let i = 0; i < cells.length; i++) {
    const ch = cells[i]; if (ch === '.') continue;
    const r = (i / COLS) | 0, c = i % COLS, x = c * BW, y = TOP + r * BH;
    cx.fillStyle = cellColor(ch); cx.fillRect(x, y, BW, BH);
    cx.fillStyle = 'rgba(255,255,255,.28)'; cx.fillRect(x, y, BW, 3);
    cx.fillStyle = 'rgba(0,0,0,.22)'; cx.fillRect(x, y + BH - 2, BW, 2); cx.fillRect(x + BW - 1, y, 1, BH);
    if (ch === 'y') { // cracked stone: darker, with a jagged crack across it
      cx.strokeStyle = 'rgba(0,0,0,.6)'; cx.lineWidth = 2; cx.beginPath();
      cx.moveTo(x + BW * 0.3, y + 2); cx.lineTo(x + BW * 0.45, y + BH * 0.45); cx.lineTo(x + BW * 0.38, y + BH * 0.6);
      cx.lineTo(x + BW * 0.6, y + BH - 2); cx.moveTo(x + BW * 0.45, y + BH * 0.45); cx.lineTo(x + BW * 0.72, y + BH * 0.32); cx.stroke();
    }
    if (ch === 'z') { cx.fillStyle = 'rgba(0,0,0,.18)'; cx.fillRect(x + BW * 0.2, y + BH * 0.35, BW * 0.15, BH * 0.25); cx.fillRect(x + BW * 0.6, y + BH * 0.5, BW * 0.2, BH * 0.2); }
    if (SPECIALS[ch]) {
      cx.fillStyle = '#111'; cx.font = '900 17px system-ui'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText(ch, x + BW / 2, y + BH / 2 + 1);
      cx.strokeStyle = 'rgba(0,0,0,.45)'; cx.lineWidth = 2; cx.strokeRect(x + 1, y + 1, BW - 2, BH - 2);
    }
  }
  cx.save(); cx.globalAlpha = paddleAlpha;
  cx.fillStyle = theme.text; cx.beginPath(); cx.roundRect(px, PADDLE_Y, pw, PADDLE_H, 4); cx.fill(); // paddle: flat
  cx.restore();
  cx.fillStyle = '#ffcc33';
  for (const [x, y] of bs) { cx.beginPath(); cx.arc(x, y, BALL_R * (scale < 1 ? 1.4 : 1), 0, 7); cx.fill(); }
  if (ready) { cx.beginPath(); cx.arc(px + pw / 2, PADDLE_Y - BALL_R - 1, BALL_R, 0, 7); cx.fill(); }
}
function fit() {
  const area = $('center').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const avH = window.innerHeight - $('bwBar').offsetHeight - $('meBar').offsetHeight - 40;
  const maxW = Math.max(320, window.innerWidth - 2 * 300 - 80); // leave room for both side columns
  const scale = Math.max(0.35, Math.min(maxW / W, avH / H));
  const cw = Math.round(W * scale), ch = Math.round(H * scale);
  if (canvas.style.width !== cw + 'px') { canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px'; $('meBar').style.width = cw + 'px'; }
  if (canvas.width !== Math.round(cw * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
}
function draw() {
  fit();
  if (!grid) newGrid(1); // something to look at before the first match
  const pw = paddleW();
  // Big Paddle about to run out: the paddle fades in and out for its last 3 s
  const bigLeft = fx && fx.paddle && fx.paddle.mul > 1 ? fx.paddle.until - now() : 0;
  const paddleAlpha = bigLeft > 0 && bigLeft < ENDING_MS ? 0.6 + 0.4 * Math.cos(now() / 1000 * Math.PI * 4) : 1;
  drawBoard(ctx, 1, { cells: grid, px: paddleX ?? (W - pw) / 2, pw, balls: (balls || []).map(b => [b.x, b.y]), ready: playing && phase === 'ready', paddleAlpha });
  let msg = null;
  if (!playing && !mode) msg = [roomState === 'lobby' ? (myId === hostId ? 'Press Space to start' : 'Waiting for the host…') : 'Game in progress, you\'re watching', ''];
  else if (phase === 'ready') msg = ['Press Space to launch', mode === 'clear' ? 'Clear every block first to win' : `${lives} ${lives === 1 ? 'life' : 'lives'} left`];
  else if (phase === 'wait') msg = [`Back in ${Math.ceil((phaseUntil - now()) / 1000)}`, mode === 'clear' ? 'Missed!' : `${lives} ${lives === 1 ? 'life' : 'lives'} left`];
  else if (phase === 'done' && mode === 'solo') msg = [`Game over: ${score} points`, soloResult || (myId === hostId ? 'Press Space for a new game' : '')];
  else if (phase === 'done' && $('status').textContent) msg = [$('status').textContent, myId === hostId ? 'Press Space for a new game' : ''];
  if (msg) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 40px system-ui'; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.strokeText(msg[0], W / 2, H * 0.72); ctx.fillStyle = phase === 'wait' ? '#ff4d5e' : '#ffcc33'; ctx.fillText(msg[0], W / 2, H * 0.72);
    ctx.font = '600 20px system-ui'; ctx.fillStyle = theme.dim; ctx.fillText(msg[1], W / 2, H * 0.72 + 38);
  }
  renderEffects();
}
let last = performance.now();
function frame(t) { const dt = Math.min(0.033, (t - last) / 1000); last = t; update(dt); draw(); requestAnimationFrame(frame); }

// other players' boards, from their snapshots
function renderOpps() {
  const wrap = $('opps'), list = ordered().slice(1);
  if (wrap.children.length !== list.length || [...wrap.children].some((el, i) => +el.dataset.id !== list[i].id || el.dataset.av !== (list[i].avatar || ''))) {
    wrap.innerHTML = '';
    for (const p of list) {
      const el = document.createElement('div'); el.className = 'opp'; el.dataset.id = p.id; el.dataset.av = p.avatar || '';
      el.innerHTML = `<div class="oname"><span class="b"></span><span class="nm">${SW.avatarHtml(p)}${esc(p.name)}</span><span class="info"></span></div><canvas width="${W / 2}" height="${H / 2}"></canvas>`;
      el.onclick = () => useSpecial(numOf(players.find(q => q.id === p.id)));
      wrap.appendChild(el);
    }
  }
  drawOpps();
}
function drawOpps() {
  for (const el of $('opps').children) {
    const p = players.find(q => q.id === +el.dataset.id); if (!p) continue;
    const b = others.get(p.id);
    el.querySelector('.b').innerHTML = badge(numOf(p), true);
    el.querySelector('.info').textContent = b ? (mode === 'clear' ? `${b.left} left` : `${'♥'.repeat(Math.max(0, b.lives))} · ${b.left} left`) : '';
    el.classList.toggle('dead', roomState !== 'lobby' && !p.alive);
    const c = el.querySelector('canvas').getContext('2d');
    c.setTransform(0.5, 0, 0, 0.5, 0, 0);
    drawBoard(c, 0.5, b ? { cells: b.cells.split(''), px: b.px, pw: b.pw, balls: b.balls, scale: 0.5 } : { cells: grid || Array(ROWS * COLS).fill('.'), px: (W - PADDLE_W) / 2, pw: PADDLE_W, balls: [], scale: 0.5 });
  }
}
function flash(id) { const el = document.querySelector(`.opp[data-id="${id}"]`); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }

// ---------- HUD ----------
function updateHud() {
  $('score').textContent = score || 0;
  $('blocks').textContent = grid ? blocksLeft() : 0;
  $('level').textContent = level || 1;
  $('lives').textContent = mode === 'clear' ? '∞' : '♥'.repeat(Math.max(0, lives || 0));
}
function renderQueue() {
  let html = '';
  for (let i = 0; i < QUEUE_MAX; i++) {
    const s = (queue || [])[i];
    html += s ? `<div class="q${i === 0 ? ' next' : ''}" style="background:${SPECIALS[s][1]}" title="${SPECIALS[s][0]}: ${SPECIALS[s][2]}">${s}</div>` : '<div class="q empty"></div>';
  }
  $('queue').innerHTML = html;
}
let lastFx = '';
const blinkOff = left => left < ENDING_MS && Math.floor(now() / 250) % 2 === 1;
function renderEffects() {
  const t = now(), out = [];
  if (fx && fx.speed && fx.speed.until > t) out.push([fx.speed.mul > 1 ? 'Fast' : 'Slow', fx.speed.mul > 1 ? '#ff7b7b' : '#a0c4ff', fx.speed.until]);
  if (fx && fx.boom && fx.boom.until > t) out.push(['Explosivo', '#ff5aa0', fx.boom.until]);
  if (fx && fx.paddle && fx.paddle.until > t) out.push([fx.paddle.mul > 1 ? 'Big paddle' : 'Tiny paddle', fx.paddle.mul > 1 ? '#4cde6c' : '#ff9a3c', fx.paddle.until]);
  // the last 3 s blink so you notice from the corner of your eye that it's about to run out
  const html = out.map(([n, c, u]) => `<span class="${blinkOff(u - t) ? 'off' : ''}" style="background:${c}">${n} ${Math.ceil((u - t) / 1000)}</span>`).join('');
  if (html !== lastFx) { lastFx = html; $('effects').innerHTML = html; }
}
function renderPlayers() {
  const me = players.find(p => p.id === myId);
  $('meName').innerHTML = me ? `${badge(1, true)}<span>${SW.avatarHtml(me)}${esc(me.name)}</span>` : '';
  $('players').innerHTML = ordered().map(p => {
    const b = p.id === myId ? null : others.get(p.id);
    const info = p.wins ? `${p.wins}★` : '';
    return `<div class="${roomState !== 'lobby' && !p.alive ? 'dead' : ''}"><span class="crown">${p.id === hostId ? '👑' : ''}</span>${myId === hostId && p.id !== myId ? `<span class="mkHost" data-id="${p.id}" title="Make ${esc(p.name)} host">${badge(numOf(p))}</span>` : badge(numOf(p))}<span class="nm">${SW.avatarHtml(p)}${esc(p.name)}${p.id === myId ? ' (you)' : ''}</span><span class="info">${info}</span></div>`;
  }).join('');
  for (const b of $('players').querySelectorAll('.mkHost')) b.onclick = () => net({ t: 'sethost', id: +b.dataset.id }); // host: click a number to hand over host
  const host = myId === hostId && roomState === 'lobby', multi = players.length > 1;
  $('modeBox').classList.toggle('hidden', !(host && multi));
  for (const b of $('modes').children) b.classList.toggle('on', b.dataset.mode === lobbyMode);
  $('startBtn').classList.toggle('hidden', !host);
  $('startBtn').textContent = multi ? 'Start game' : 'Start solo';
  $('modeInfo').textContent = roomState !== 'lobby' ? '' : !multi ? 'Solo: endless rows, faster every level' : lobbyMode === 'clear' ? 'Next game: Clear race (first to clear every block wins)' : 'Next game: Lives (3 lives each, last one standing wins)';
  renderOpps();
}
function setStatus(s) { $('status').textContent = s; }
const logScroll = SW.stickyScroll($('log')); // follows new lines unless you've scrolled up to read
function addLine(d) { logScroll.add(d); }
function log(msg) { const d = document.createElement('div'); d.className = 'ev'; d.textContent = msg; addLine(d); }
function chatLine(id, msg) { const p = players.find(q => q.id === id), d = document.createElement('div'); d.innerHTML = `<span class="who" style="color:${p ? SLOT_COLORS[numOf(p)] : ''}">${SW.avatarHtml(p)}${esc(nameOf(id))}</span>`; d.appendChild(document.createTextNode(msg)); addLine(d); }

// ---------- network ----------
function net(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
let lastSync = 0;
function sync(force) {
  // periodic snapshot of my board for everyone else's side view
  if (!grid || (!force && performance.now() - lastSync < SYNC_MS)) return;
  lastSync = performance.now();
  net({ t: 'board', cells: grid.join(''), px: Math.round(paddleX ?? 0), pw: Math.round(paddleW()), balls: (balls || []).map(b => [Math.round(b.x), Math.round(b.y)]), lives, left: blocksLeft(), score, level, broken: brokenCount, lost: livesLost });
}
setInterval(() => { if (playing) sync(); }, SYNC_MS);
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => net({ t: 'join', game: 'block', name, room: roomCode, bid: SW.bid, avatar: SW.avatar() });
  ws.onclose = () => setStatus('Disconnected. Reload to rejoin.');
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'error': setStatus(m.msg); break;
      case 'welcome': myId = m.id; $('roomName').textContent = m.room; break;
      case 'lobby':
        if (m.mode !== lobbyMode && m.state === 'lobby' && !playing) setStatus('');
        players = m.players; hostId = m.hostId; roomState = m.state; lobbyMode = m.mode; renderPlayers(); break;
      case 'start':
        players = m.players; roomState = 'playing'; others.clear(); setStatus('');
        log(m.mode === 'solo' ? '— Solo game started —' : `— ${m.mode === 'clear' ? 'Clear race' : 'Lives'} game started —`);
        startMatch(m.seed, m.mode); renderPlayers(); break;
      case 'board': others.set(m.id, m); drawOpps(); break;
      case 'special': applySpecial(m.special); break;
      case 'addrows': addRows(Math.min(5, m.n | 0)); break; // an opponent broke another 24 blocks
      case 'used': { const sp = SPECIALS[m.special]; log(`${nameOf(m.from)} → ${m.from === m.to ? 'self' : nameOf(m.to)}: ${sp ? sp[0] : m.special}`); flash(m.to); break; }
      case 'dead': { const p = players.find(q => q.id === m.id); if (p) p.alive = false; renderPlayers(); break; }
      case 'gameover': {
        playing = false; roomState = 'lobby';
        if (mode !== 'solo') setStatus(m.winnerId === myId ? '🏆 You win!' : m.winnerName ? `${m.winnerName} wins!` : 'Game over');
        if (m.winnerName) log(`— ${m.winnerName} wins (${m.why}) —`);
        phase = 'done'; mode = mode || null; renderPlayers();
        break;
      }
      case 'solo': // solo run saved: did it make the leaderboard?
        soloResult = (m.score && !m.error && !m.onBoard && m.best > m.prevBest ? 'New personal best! ' : '') + SW.leaderboardText(m, 'points');
        setStatus(`Game over: ${score} points. ${soloResult}`); log(`Game over: ${score} points. ${soloResult}`);
        break;
      case 'log': log(m.msg); break;
      case 'chat': chatLine(m.id, m.msg); break;
    }
  };
}

// ---------- input ----------
// paddle keys for each control scheme (⚙ Settings); before a player picks one, both work
const ARROW_KEYS = { ArrowLeft: 'left', ArrowRight: 'right' }, WASD_KEYS = { a: 'left', d: 'right' };
const moveKey = key => {
  const c = SW.controls(), k = key.length === 1 ? key.toLowerCase() : key;
  return (c !== 'wasd' && ARROW_KEYS[k]) || (c !== 'arrows' && WASD_KEYS[k]) || null;
};
const renderKeysHelp = () => { $('keysHelp').innerHTML = `<b>${{ wasd: 'A / D', arrows: '← / →' }[SW.controls()] || '← / → or A / D'}</b> move · <b>Space</b> launch (host: start) · <b>1–6</b> fire your next special at that player (1 = you) · <b>X</b> discard · or click a board · change keys in ⚙ Settings`; };
document.addEventListener('keydown', e => {
  if (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === 't' || e.key === 'T') { $('chat').focus(); e.preventDefault(); return; } // T opens chat
  const mv = moveKey(e.key);
  if (mv) { keys.add(mv); e.preventDefault(); return; }
  if (/^[1-6]$/.test(e.key)) { useSpecial(+e.key); return; }
  if (e.key === 'x' || e.key === 'X') { if (queue && queue.length) { queue.shift(); renderQueue(); } return; }
  if (e.key === ' ') {
    e.preventDefault();
    if (playing && phase === 'ready') launch();
    else if (!playing && roomState === 'lobby' && myId === hostId) net({ t: 'start' });
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault(); // up/down do nothing (for now)
});
document.addEventListener('keyup', e => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; keys.delete(ARROW_KEYS[k]); keys.delete(WASD_KEYS[k]); });
window.addEventListener('blur', () => keys.clear());
$('chat').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { if (e.target.value.trim()) net({ t: 'chat', msg: e.target.value }); e.target.value = ''; e.target.blur(); }
  else if (e.key === 'Escape') e.target.blur();
});
$('startBtn').onclick = e => { net({ t: 'start' }); e.target.blur(); };
for (const b of $('modes').children) b.onclick = e => { net({ t: 'mode', mode: b.dataset.mode }); e.currentTarget.blur(); };
// Leave the room for real: tell the server first (so it drops you immediately), then close.
function leaveRoom() { try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'leave' })); ws.close(); } } catch {} }
window.addEventListener('pagehide', leaveRoom); // tab closed, reloaded, browser back, or Back to lobby
$('leaveBtn').onclick = e => {
  if (playing && !confirm('Leave this game? You will be counted as out.')) { e.target.blur(); return; }
  leaveRoom(); location.href = '/';
};
SW.mountSettings($('themeBar')); // ⚙ Settings: theme + controls, saved per browser
SW.onChange(() => { readTheme(); renderKeysHelp(); keys.clear(); });
// a new avatar picked in ⚙ Settings shows up for everyone in the room straight away
let sentAvatar = SW.avatar();
SW.onChange(() => { if (SW.avatar() !== sentAvatar) { sentAvatar = SW.avatar(); net({ t: 'avatar', a: sentAvatar }); } });
renderKeysHelp();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);
$('specialList').innerHTML = SP_KEYS.map(k => `<li><span class="sp" style="background:${SPECIALS[k][1]}">${k}</span><span><b>${SPECIALS[k][0]}</b> – ${SPECIALS[k][2]}</span></li>`).join('');

// test hook: lets automated checks read and steer the game state
window.__bw = {
  get state() { return { ballSpeed, speedLevel, grid, balls, paddleX, lives, score, level, queue, phase, mode, playing, fx, pendingBalls, paddleW: paddleW(), speedMul: speedMul() }; },
  set paddle(x) { paddleX = x; }, setLevel(l) { level = l; }, place(b) { balls = [{ ...b }]; phase = 'play'; }, apply: applySpecial, setLives(n) { lives = n; },
  setCell(r, c, ch) { grid[idx(r, c)] = ch; }, clearAll(keep = 0) { let k = 0; for (let i = 0; i < grid.length; i++) if (grid[i] !== '.' && k++ >= keep) grid[i] = '.'; },
};

readTheme(); renderQueue(); updateHud(); connect(); requestAnimationFrame(frame);
})();
