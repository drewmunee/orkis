// Blockwar client. Your own game runs here (physics, blocks, specials); the server starts matches,
// relays board snapshots (about 4 a second) and specials, and decides who wins.
(() => {
const $ = id => document.getElementById(id);
const W = 800, H = 600;                         // logical board size (4:3), scaled to fit
const COLS = 12, ROWS = 18, TOP = 40, BH = 24;  // block grid; rows below the starting 8 fill up in solo / from Random
const BW = W / COLS, START_ROWS = 8;
const ROW_COLORS = ['#ff4d5e', '#ff8a3d', '#ffc93d', '#9be15d', '#3ccf6e', '#30d5ff', '#3d7bff', '#b45cff'];
const STONE = '#8d8478';
const PADDLE_W = 110, PADDLE_H = 14, PADDLE_Y = H - 40, PADDLE_SPEED = 640;
const BALL_R = 8, START_SPEED = 380, SPEED_UP = 3, MAX_SPEED = 700;
const MAX_ANGLE = Math.PI / 3;                  // paddle edge sends the ball out at 60° from straight up
const START_LIVES = 3, RESPAWN_MS = 5000, FX_MS = 10000, QUEUE_MAX = 3, SPECIAL_RATE = 0.07;
const SYNC_MS = 250;                            // how often your board is sent to the others
// Specials (letter blocks you break to collect): [name, color, description, weight]
const SPECIALS = {
  R: ['Random', '#b08968', 'drops a boulder or stalactite of breakable stone onto the board', 4],
  C: ['Clear Line', '#7bffb0', 'instantly removes the lowest row of blocks', 3],
  M: ['Multiball', '#ffd23f', 'doubles the number of balls (a life is only lost when every ball is gone)', 3],
  S: ['Slow Ball', '#a0c4ff', 'halves ball speed for 10 seconds', 3],
  F: ['Fast Ball', '#ff7b7b', 'doubles ball speed for 10 seconds', 3],
  B: ['Big Paddle', '#4cde6c', 'doubles paddle width for 10 seconds', 3],
  T: ['Tiny Paddle', '#ff9a3c', 'halves paddle width for 10 seconds', 3],
  Q: ['Earthquake', '#c8a2ff', 'shuffles the board and buries its specials away from the edge', 2],
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
let grid, balls = [], paddleX, lives, score = 0, level = 1, brokenSinceRow, rowsAdded, phase, phaseUntil, pendingBalls, ballSpeed;
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
function pickSpecial(rand = Math.random) {
  const total = SP_KEYS.reduce((s, k) => s + SPECIALS[k][3], 0);
  let r = rand() * total;
  for (const k of SP_KEYS) { r -= SPECIALS[k][3]; if (r < 0) return k; }
  return SP_KEYS[0];
}

// ---------- the grid: '.' empty, 'a'-'h' colored block (by row), 'z' stone, uppercase = special ----------
const idx = (r, c) => r * COLS + c;
function makeRow(r, rand) { const row = []; for (let c = 0; c < COLS; c++) row.push(rand() < SPECIAL_RATE ? pickSpecial(rand) : 'abcdefgh'[r % 8]); return row; }
function newGrid(seed) {
  const rand = mulberry32(seed);
  grid = Array(ROWS * COLS).fill('.');
  for (let r = 0; r < START_ROWS; r++) makeRow(r, rand).forEach((ch, c) => { grid[idx(r, c)] = ch; });
}
const blocksLeft = () => grid.reduce((n, ch) => n + (ch !== '.'), 0);
const cellColor = ch => ch === 'z' ? STONE : ch >= 'a' && ch <= 'h' ? ROW_COLORS[ch.charCodeAt(0) - 97] : (SPECIALS[ch] || [0, '#888'])[1];

// ---------- match flow ----------
function startMatch(seed, m) {
  mode = m; playing = true;
  newGrid(seed);
  lives = START_LIVES; score = 0; level = 1; brokenSinceRow = 0; rowsAdded = 0; queue = []; fx = {}; pendingBalls = 1; ballSpeed = START_SPEED;
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
  net({ t: 'out', score, level });
  setStatus(mode === 'solo' ? `${why ? why + ' ' : ''}Game over: ${score} points (level ${level})` : 'Out of lives!');
  updateHud(); sync(true);
}
function loseLife() {
  // clear races never run out of lives; lives mode and solo do
  if (mode !== 'clear') lives--;
  updateHud();
  if (mode !== 'clear' && lives <= 0) return gameOver();
  phase = 'wait'; phaseUntil = performance.now() + RESPAWN_MS; balls = [];
}
function boardCleared() {
  if (mode === 'clear') { phase = 'done'; playing = false; net({ t: 'cleared' }); sync(true); return; }
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
  grid.unshift(...makeRow(START_ROWS + rowsAdded, Math.random));
  rowsAdded++; level = 1 + Math.floor(rowsAdded / 5);
  updateHud();
}
const levelMul = () => mode === 'solo' ? 1 + 0.08 * (level - 1) : 1; // +8% ball speed per level

// ---------- effects from specials ----------
const now = () => performance.now();
const paddleW = () => PADDLE_W * (fx.paddle && fx.paddle.until > now() ? fx.paddle.mul : 1);
const speedMul = () => (fx.speed && fx.speed.until > now() ? fx.speed.mul : 1) * levelMul();
function applySpecial(s) {
  if (!playing) return;
  switch (s) {
    case 'R': addRock(); break;
    case 'C': { // lowest row with anything in it
      for (let r = ROWS - 1; r >= 0; r--) if (grid.slice(idx(r, 0), idx(r, COLS)).some(ch => ch !== '.')) { for (let c = 0; c < COLS; c++) grid[idx(r, c)] = '.'; break; }
      if (!blocksLeft()) boardCleared();
      break;
    }
    case 'M':
      if (phase === 'play') balls = balls.concat(balls.map(b => ({ ...b, vx: -b.vx || 0.3 })));
      else pendingBalls *= 2;
      break;
    case 'S': fx.speed = { mul: 0.5, until: now() + FX_MS }; break;
    case 'F': fx.speed = { mul: 2, until: now() + FX_MS }; break;
    case 'B': fx.paddle = { mul: 2, until: now() + FX_MS }; break;
    case 'T': fx.paddle = { mul: 0.5, until: now() + FX_MS }; break;
    case 'Q': earthquake(); break;
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
  const ch = grid[best]; grid[best] = '.';
  if (SPECIALS[ch]) { queue.push(ch); if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX); renderQueue(); }
  score += ch === 'z' ? 5 : 10;
  ballSpeed = Math.min(MAX_SPEED, ballSpeed + SPEED_UP);
  let [dx, dy] = bn;
  if (dx === 0 && dy === 0) { dx = -b.vx; dy = -b.vy; }
  if (Math.abs(dx) > Math.abs(dy)) { if (Math.sign(b.vx) !== Math.sign(dx)) b.vx = -b.vx; }
  else if (Math.sign(b.vy) !== Math.sign(dy)) b.vy = -b.vy;
  soloProgress();
  if (!blocksLeft()) boardCleared();
  updateHud();
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
function drawBoard(cx, s, { cells, px, pw, balls: bs, ready, scale = 1 }) {
  cx.fillStyle = theme.well; cx.fillRect(0, 0, W, H);
  for (let i = 0; i < cells.length; i++) {
    const ch = cells[i]; if (ch === '.') continue;
    const r = (i / COLS) | 0, c = i % COLS, x = c * BW, y = TOP + r * BH;
    cx.fillStyle = cellColor(ch); cx.fillRect(x, y, BW, BH);
    cx.fillStyle = 'rgba(255,255,255,.28)'; cx.fillRect(x, y, BW, 3);
    cx.fillStyle = 'rgba(0,0,0,.22)'; cx.fillRect(x, y + BH - 2, BW, 2); cx.fillRect(x + BW - 1, y, 1, BH);
    if (ch === 'z') { cx.fillStyle = 'rgba(0,0,0,.18)'; cx.fillRect(x + BW * 0.2, y + BH * 0.35, BW * 0.15, BH * 0.25); cx.fillRect(x + BW * 0.6, y + BH * 0.5, BW * 0.2, BH * 0.2); }
    if (SPECIALS[ch]) {
      cx.fillStyle = '#111'; cx.font = '900 17px system-ui'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText(ch, x + BW / 2, y + BH / 2 + 1);
      cx.strokeStyle = 'rgba(0,0,0,.45)'; cx.lineWidth = 2; cx.strokeRect(x + 1, y + 1, BW - 2, BH - 2);
    }
  }
  cx.fillStyle = theme.text; cx.beginPath(); cx.roundRect(px, PADDLE_Y, pw, PADDLE_H, 4); cx.fill(); // paddle: flat
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
  drawBoard(ctx, 1, { cells: grid, px: paddleX ?? (W - pw) / 2, pw, balls: (balls || []).map(b => [b.x, b.y]), ready: playing && phase === 'ready' });
  let msg = null;
  if (!playing && !mode) msg = [roomState === 'lobby' ? (myId === hostId ? 'Press Space to start' : 'Waiting for the host…') : 'Game in progress, you\'re watching', ''];
  else if (phase === 'ready') msg = ['Press Space to launch', mode === 'clear' ? 'Clear every block first to win' : `${lives} ${lives === 1 ? 'life' : 'lives'} left`];
  else if (phase === 'wait') msg = [`Back in ${Math.ceil((phaseUntil - now()) / 1000)}`, mode === 'clear' ? 'Missed!' : `${lives} ${lives === 1 ? 'life' : 'lives'} left`];
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
  if (wrap.children.length !== list.length || [...wrap.children].some((el, i) => +el.dataset.id !== list[i].id)) {
    wrap.innerHTML = '';
    for (const p of list) {
      const el = document.createElement('div'); el.className = 'opp'; el.dataset.id = p.id;
      el.innerHTML = `<div class="oname"><span class="b"></span><span class="nm">${esc(p.name)}</span><span class="info"></span></div><canvas width="${W / 2}" height="${H / 2}"></canvas>`;
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
function renderEffects() {
  const t = now(), out = [];
  if (fx && fx.speed && fx.speed.until > t) out.push([fx.speed.mul > 1 ? 'Fast' : 'Slow', fx.speed.mul > 1 ? '#ff7b7b' : '#a0c4ff', fx.speed.until]);
  if (fx && fx.paddle && fx.paddle.until > t) out.push([fx.paddle.mul > 1 ? 'Big paddle' : 'Tiny paddle', fx.paddle.mul > 1 ? '#4cde6c' : '#ff9a3c', fx.paddle.until]);
  const html = out.map(([n, c, u]) => `<span style="background:${c}">${n} ${Math.ceil((u - t) / 1000)}</span>`).join('');
  if (html !== lastFx) { lastFx = html; $('effects').innerHTML = html; }
}
function renderPlayers() {
  const me = players.find(p => p.id === myId);
  $('meName').innerHTML = me ? `${badge(1, true)}<span>${esc(me.name)}</span>` : '';
  $('players').innerHTML = ordered().map(p => {
    const b = p.id === myId ? null : others.get(p.id);
    const info = p.wins ? `${p.wins}★` : '';
    return `<div class="${roomState !== 'lobby' && !p.alive ? 'dead' : ''}">${badge(numOf(p))}<span class="nm">${esc(p.name)}${p.id === hostId ? ' 👑' : ''}${p.id === myId ? ' (you)' : ''}</span><span class="info">${info}</span></div>`;
  }).join('');
  const host = myId === hostId && roomState === 'lobby', multi = players.length > 1;
  $('modeBox').classList.toggle('hidden', !(host && multi));
  for (const b of $('modes').children) b.classList.toggle('on', b.dataset.mode === lobbyMode);
  $('startBtn').classList.toggle('hidden', !host);
  $('startBtn').textContent = multi ? 'Start game' : 'Start solo';
  $('modeInfo').textContent = roomState !== 'lobby' ? '' : !multi ? 'Solo: endless rows, faster every level' : lobbyMode === 'clear' ? 'Next game: Clear race (first to clear every block wins)' : 'Next game: Lives (3 lives each, last one standing wins)';
  renderOpps();
}
function setStatus(s) { $('status').textContent = s; }
let chatPinned = true;
$('log').addEventListener('scroll', () => { const l = $('log'); if (l.clientHeight) chatPinned = l.scrollHeight - l.scrollTop - l.clientHeight < 30; });
function addLine(d) { const l = $('log'); l.appendChild(d); while (l.children.length > 150) l.firstChild.remove(); if (chatPinned) l.scrollTop = l.scrollHeight; }
function log(msg) { const d = document.createElement('div'); d.className = 'ev'; d.textContent = msg; addLine(d); }
function chatLine(id, msg) { const p = players.find(q => q.id === id), d = document.createElement('div'); d.innerHTML = `<span class="who" style="color:${p ? SLOT_COLORS[numOf(p)] : ''}">${esc(nameOf(id))}</span>`; d.appendChild(document.createTextNode(msg)); addLine(d); }

// ---------- network ----------
function net(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
let lastSync = 0;
function sync(force) {
  // periodic snapshot of my board for everyone else's side view
  if (!grid || (!force && performance.now() - lastSync < SYNC_MS)) return;
  lastSync = performance.now();
  net({ t: 'board', cells: grid.join(''), px: Math.round(paddleX ?? 0), pw: Math.round(paddleW()), balls: (balls || []).map(b => [Math.round(b.x), Math.round(b.y)]), lives, left: blocksLeft(), score, level });
}
setInterval(() => { if (playing) sync(); }, SYNC_MS);
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => net({ t: 'join', game: 'block', name, room: roomCode });
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
      case 'used': { const sp = SPECIALS[m.special]; log(`${nameOf(m.from)} → ${m.from === m.to ? 'self' : nameOf(m.to)}: ${sp ? sp[0] : m.special}`); flash(m.to); break; }
      case 'dead': { const p = players.find(q => q.id === m.id); if (p) p.alive = false; renderPlayers(); break; }
      case 'gameover': {
        playing = false; roomState = 'lobby';
        if (mode !== 'solo') setStatus(m.winnerId === myId ? '🏆 You win!' : m.winnerName ? `${m.winnerName} wins!` : 'Game over');
        if (m.winnerName) log(`— ${m.winnerName} wins (${m.why}) —`);
        phase = 'done'; mode = mode || null; renderPlayers();
        break;
      }
      case 'log': log(m.msg); break;
      case 'chat': chatLine(m.id, m.msg); break;
    }
  };
}

// ---------- input ----------
const KEYMAP = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' };
document.addEventListener('keydown', e => {
  if (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === 'Enter') { $('chat').focus(); e.preventDefault(); return; }
  if (KEYMAP[e.key]) { keys.add(KEYMAP[e.key]); e.preventDefault(); return; }
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
document.addEventListener('keyup', e => { if (KEYMAP[e.key]) keys.delete(KEYMAP[e.key]); });
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
$('theme').value = document.documentElement.dataset.theme || 'system';
$('theme').addEventListener('change', e => { document.documentElement.dataset.theme = e.target.value; try { localStorage.setItem('sw-theme', e.target.value); } catch {} readTheme(); e.target.blur(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);
$('specialList').innerHTML = SP_KEYS.map(k => `<li><span class="sp" style="background:${SPECIALS[k][1]}">${k}</span><span><b>${SPECIALS[k][0]}</b> – ${SPECIALS[k][2]}</span></li>`).join('');

// test hook: lets automated checks read and steer the game state
window.__bw = {
  get state() { return { grid, balls, paddleX, lives, score, level, queue, phase, mode, playing, fx, pendingBalls, paddleW: paddleW(), speedMul: speedMul() }; },
  set paddle(x) { paddleX = x; }, place(b) { balls = [{ ...b }]; phase = 'play'; }, apply: applySpecial, setLives(n) { lives = n; },
  setCell(r, c, ch) { grid[idx(r, c)] = ch; }, clearAll(keep = 0) { let k = 0; for (let i = 0; i < grid.length; i++) if (grid[i] !== '.' && k++ >= keep) grid[i] = '.'; },
};

readTheme(); renderQueue(); updateHud(); connect(); requestAnimationFrame(frame);
})();
