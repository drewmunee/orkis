// Blockwar: single-player block breaker. Runs entirely in the browser.
(() => {
const $ = id => document.getElementById(id);
const W = 800, H = 600;                         // logical board size (4:3); scaled to fit the window
const COLS = 12, ROWS = 8, TOP = 70, BH = 26;   // block grid: no gaps between blocks
const BW = W / COLS;
const ROW_COLORS = ['#ff4d5e', '#ff8a3d', '#ffc93d', '#9be15d', '#3ccf6e', '#30d5ff', '#3d7bff', '#b45cff'];
const PADDLE_W = 110, PADDLE_H = 14, PADDLE_Y = H - 40, PADDLE_SPEED = 640;
const BALL_R = 8, START_SPEED = 380, SPEED_UP = 4, MAX_SPEED = 720;
const MAX_ANGLE = Math.PI / 3;                  // paddle edge sends the ball out at 60° from straight up
const START_LIVES = 3;

const canvas = $('board'), ctx = canvas.getContext('2d');
let blocks, paddleX, ball, lives, score, mode; // mode: 'ready' (ball on paddle) | 'play' | 'won' | 'over'
const keys = new Set();
let theme = {};
function readTheme() { const cs = getComputedStyle(document.documentElement); theme = { well: cs.getPropertyValue('--well').trim(), text: cs.getPropertyValue('--text').trim(), dim: cs.getPropertyValue('--dim').trim() }; }

function newGame() {
  blocks = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++)
    blocks.push({ x: c * BW, y: TOP + r * BH, w: BW, h: BH, row: r, alive: true });
  lives = START_LIVES; score = 0;
  resetBall();
}
function resetBall() {
  paddleX = (W - PADDLE_W) / 2;                  // paddle always starts in the middle
  ball = { x: W / 2, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0, speed: START_SPEED };
  mode = 'ready';
  updateHud();
}
function launch() {
  // a random direction up and away from the paddle
  const a = (Math.random() * 2 - 1) * MAX_ANGLE;
  ball.vx = Math.sin(a) * ball.speed; ball.vy = -Math.cos(a) * ball.speed;
  mode = 'play';
}
function updateHud() {
  $('score').textContent = score;
  $('blocks').textContent = blocks.filter(b => b.alive).length;
  $('lives').textContent = '♥'.repeat(Math.max(0, lives));
}

// The paddle is drawn flat but bounces like a half circle: where the ball lands decides where it goes.
// Dead center sends it straight up; toward an end sends it out to that side (up to 60°), whatever
// direction it came in from.
function bounceOffPaddle() {
  const off = Math.max(-1, Math.min(1, (ball.x - (paddleX + PADDLE_W / 2)) / (PADDLE_W / 2 + BALL_R)));
  const a = off * MAX_ANGLE;
  ball.vx = Math.sin(a) * ball.speed; ball.vy = -Math.cos(a) * ball.speed;
  ball.y = PADDLE_Y - BALL_R - 0.5;
}

// Blocks: find the block the ball overlaps most, break it, and bounce off the side it hit.
function hitBlocks() {
  let best = null, bestD = Infinity, bestN = null;
  for (const b of blocks) {
    if (!b.alive) continue;
    const nx = Math.max(b.x, Math.min(ball.x, b.x + b.w)), ny = Math.max(b.y, Math.min(ball.y, b.y + b.h));
    const dx = ball.x - nx, dy = ball.y - ny, d = dx * dx + dy * dy;
    if (d < BALL_R * BALL_R && d < bestD) { best = b; bestD = d; bestN = [dx, dy]; }
  }
  if (!best) return;
  best.alive = false;
  score += 10 * (ROWS - best.row); // higher rows are worth more
  ball.speed = Math.min(MAX_SPEED, ball.speed + SPEED_UP);
  let [dx, dy] = bestN;
  if (dx === 0 && dy === 0) { dx = -ball.vx; dy = -ball.vy; } // center inside the block: back out the way it came
  // bounce off whichever side was hit (corners: the side it's hitting more squarely)
  if (Math.abs(dx) > Math.abs(dy)) { if (Math.sign(ball.vx) !== Math.sign(dx)) ball.vx = -ball.vx; }
  else { if (Math.sign(ball.vy) !== Math.sign(dy)) ball.vy = -ball.vy; }
  const s = Math.hypot(ball.vx, ball.vy) || 1; ball.vx *= ball.speed / s; ball.vy *= ball.speed / s;
  updateHud();
  if (!blocks.some(b => b.alive)) mode = 'won';
}

function update(dt) {
  const dir = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  paddleX = Math.max(0, Math.min(W - PADDLE_W, paddleX + dir * PADDLE_SPEED * dt));
  if (mode === 'ready') { ball.x = paddleX + PADDLE_W / 2; return; }
  if (mode !== 'play') return;
  // move in small steps so a fast ball can't skip through a block or the paddle
  const steps = Math.ceil(ball.speed * dt / (BALL_R * 0.5));
  for (let i = 0; i < steps && mode === 'play'; i++) {
    ball.x += ball.vx * dt / steps; ball.y += ball.vy * dt / steps;
    if (ball.x < BALL_R) { ball.x = BALL_R; ball.vx = Math.abs(ball.vx); }
    if (ball.x > W - BALL_R) { ball.x = W - BALL_R; ball.vx = -Math.abs(ball.vx); }
    if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }
    if (ball.vy > 0 && ball.y + BALL_R >= PADDLE_Y && ball.y - BALL_R <= PADDLE_Y + PADDLE_H
        && ball.x >= paddleX - BALL_R && ball.x <= paddleX + PADDLE_W + BALL_R) bounceOffPaddle();
    hitBlocks();
    if (ball.y - BALL_R > H) { // missed it
      lives--;
      if (lives <= 0) { mode = 'over'; updateHud(); } else resetBall();
    }
  }
}

// ---------- drawing ----------
function fit() {
  const st = $('stage').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const scale = Math.max(0.3, Math.min((st.width - 24) / W, (st.height - 24) / H));
  const cw = Math.round(W * scale), ch = Math.round(H * scale);
  if (canvas.style.width !== cw + 'px') { canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px'; }
  if (canvas.width !== Math.round(cw * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
}
function draw() {
  fit();
  ctx.fillStyle = theme.well; ctx.fillRect(0, 0, W, H);
  for (const b of blocks) {
    if (!b.alive) continue;
    ctx.fillStyle = ROW_COLORS[b.row % ROW_COLORS.length]; ctx.fillRect(b.x, b.y, b.w, b.h);
    // thin shading so touching blocks still read as separate pieces
    ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fillRect(b.x, b.y, b.w, 3);
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(b.x, b.y + b.h - 2, b.w, 2); ctx.fillRect(b.x + b.w - 1, b.y, 1, b.h);
  }
  // paddle: flat
  ctx.fillStyle = theme.text; ctx.beginPath(); ctx.roundRect(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H, 4); ctx.fill();
  // ball
  ctx.fillStyle = '#ffcc33'; ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, 7); ctx.fill();
  // messages
  const msg = mode === 'ready' ? ['Press Space to launch', lives < START_LIVES ? `${lives} ${lives === 1 ? 'life' : 'lives'} left` : '']
    : mode === 'won' ? ['You cleared the board!', `Score ${score} · Space to play again`]
    : mode === 'over' ? ['Game over', `Score ${score} · Space to play again`] : null;
  if (msg) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 40px system-ui'; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.strokeText(msg[0], W / 2, H * 0.62); ctx.fillStyle = mode === 'won' ? '#4cde6c' : mode === 'over' ? '#ff4d5e' : '#ffcc33'; ctx.fillText(msg[0], W / 2, H * 0.62);
    ctx.font = '600 20px system-ui'; ctx.fillStyle = theme.dim; ctx.fillText(msg[1], W / 2, H * 0.62 + 40);
  }
}
let last = performance.now();
function frame(t) {
  const dt = Math.min(0.033, (t - last) / 1000); last = t;
  update(dt); draw();
  requestAnimationFrame(frame);
}

// ---------- input ----------
const KEYMAP = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' };
document.addEventListener('keydown', e => {
  if (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (KEYMAP[e.key]) { keys.add(KEYMAP[e.key]); e.preventDefault(); return; }
  if (e.key === ' ') {
    e.preventDefault();
    if (mode === 'ready') launch();
    else if (mode === 'won' || mode === 'over') newGame();
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault(); // up/down do nothing (for now)
});
document.addEventListener('keyup', e => { if (KEYMAP[e.key]) keys.delete(KEYMAP[e.key]); });
window.addEventListener('blur', () => keys.clear());
$('leaveBtn').onclick = () => { location.href = '/'; };
$('theme').value = document.documentElement.dataset.theme || 'system';
$('theme').addEventListener('change', e => { document.documentElement.dataset.theme = e.target.value; try { localStorage.setItem('sw-theme', e.target.value); } catch {} readTheme(); e.target.blur(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);

// test hook: lets automated checks read and steer the game state
window.__bw = { get state() { return { blocks, paddleX, ball, lives, score, mode }; }, set paddle(x) { paddleX = x; }, place(b) { Object.assign(ball, b); mode = 'play'; } };

readTheme(); newGame(); requestAnimationFrame(frame);
})();
