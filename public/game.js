// Stackwar client
(() => {
const W = 10, H = 23, CELL = 30;
const COLORS = { '1':'#30d5ff', '2':'#ffd23f', '3':'#b45cff', '4':'#4cde6c', '5':'#ff5470', '6':'#3d7bff', '7':'#ff9a3c', '8':'#6b6f8f' };
const PIECES = [ // id, matrix
  ['1', [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]]],
  ['2', [[1,1],[1,1]]],
  ['3', [[0,1,0],[1,1,1],[0,0,0]]],
  ['4', [[0,1,1],[1,1,0],[0,0,0]]],
  ['5', [[1,1,0],[0,1,1],[0,0,0]]],
  ['6', [[1,0,0],[1,1,1],[0,0,0]]],
  ['7', [[0,0,1],[1,1,1],[0,0,0]]],
];
// Specials: letter -> [name, color, description, weight]
const SPECIALS = {
  A: ['Add Line',     '#ff7b7b', 'Adds a junk line to the bottom of the target board', 6],
  C: ['Clear Line',   '#7bffb0', 'Removes the bottom line of the target board', 6],
  R: ['Random Clear', '#7bd3ff', 'Knocks 8 random blocks out of the target board', 4],
  Q: ['Earthquake',   '#ffb347', 'Shakes every row of the target board sideways', 3],
  G: ['Gravity',      '#c8a2ff', 'Drops all blocks down, filling every hole', 1.5],
  B: ['Blank',        '#d0d0d0', 'Turns 3 of the target\'s special blocks into junk', 3],
  H: ['Haste',        '#ff66d9', 'Target pieces fall 3x faster for 10 seconds', 3],
  D: ['Darkness',     '#3b3363', 'Blacks out the target board for 4 seconds (only the falling piece stays faintly visible)', 3, '#fff'],
  I: ['Inverted',     '#19d3b5', 'Scrambles the target\'s controls for 5 seconds: left/right swap, rotations reverse, and up/down swap', 3],
  S: ['Switch',       '#fff36b', 'Switches your whole board with the target', 0.7],
  N: ['Nuke',         '#ffffff', 'Wipes the target board completely clean', 0.7],
};
const SP_KEYS = Object.keys(SPECIALS);
const MAX_INV = 5; // collecting past this drops the oldest (next-to-fire) specials
const DARKNESS_MS = 4000;
const SLOT_COLORS = ['', '#ff5470', '#30d5ff', '#4cde6c', '#ffd23f', '#b45cff', '#ff9a3c'];
const badge = (n, big) => `<span class="slot${big ? ' big' : ''}" style="background:${SLOT_COLORS[n]}">${n}</span>`;
// Numbers are per viewer: you are always 1 on your own screen, everyone else is 2, 3, ... in join-slot order.
// The server still identifies players by their slot; we translate when firing a special.
const ordered = () => [...players.filter(p => p.id === myId), ...players.filter(p => p.id !== myId).sort((a, b) => a.slot - b.slot)];
const numOf = p => ordered().indexOf(p) + 1;

// ---------- state ----------
let ws, myId = null, hostId = null, roomState = 'lobby';
let players = [];               // from server
const boards = new Map();       // id -> cells string
let board, piece, queue, rng, playing = false;
const COUNTDOWN_MS = 3000;
let countdownEnd = 0; // game is frozen until this time while 3-2-1 shows on every board
const countingDown = () => performance.now() < countdownEnd;
// The solo leaderboard keeps recording scores, but stays off screen until a database (Neon) is set up.
// Flip this to true to show it on the homepage and mention ranks after solo runs.
const SHOW_LEADERBOARD = true;
let soloRun = false;
// Daily run: everyone gets the same seeded solo run each (UTC) day; clear 40 lines as fast as you can.
let dailyRoom = false, dailyRun = null, dailyDone = 0; // dailyRun: {goal, day} while a daily run is on
const fmtTime = ms => { const t = Math.max(0, ms) / 1000, m = Math.floor(t / 60), sec = t - m * 60; return `${m}:${sec.toFixed(2).padStart(5, '0')}`; };
let teamMode = false; // host's toggle for the next match; players' .team is set per match ('red' | 'blue' | null)
const TEAM_COLORS = { red: '#ff4d5e', blue: '#3d7bff' };
const teamTag = t => t ? `<span class="team team-${t}">${t === 'red' ? 'Red' : 'Blue'}</span>` : ''; // game started with only this player: score goes to the leaderboard
let held = null, holdUsed = false; // saved piece index; hold allowed once per piece
let inventory = [], lines = 0, level = 1, hasteUntil = 0, darkUntil = 0, invertUntil = 0;
const INVERT_MS = 5000;
// Inverted: while active, each key does something else (hard drop stays put so nobody gets force-dropped)
const INVERT = { left: 'right', right: 'left', rotate: 'soft', soft: 'rotate', rotateAlt: 'rotateBack', rotateBack: 'rotateAlt' };
// Control schemes (⚙ Settings): keys -> actions. Space, C/Shift and 1-6 are the same in both.
const SCHEMES = {
  arrows: { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotate', ArrowDown: 'soft', x: 'rotateAlt', z: 'rotateBack', d: 'discard' },
  wasd: { a: 'left', d: 'right', w: 'rotate', s: 'soft', e: 'rotateAlt', q: 'rotateBack', x: 'discard' },
};
const scheme = () => SCHEMES[SW.controls() || 'arrows'];
function renderKeysHelp() {
  const w = (SW.controls() || 'arrows') === 'wasd';
  $('keysHelp').innerHTML = (w
    ? '<b>A / D</b> move · <b>W / E</b> rotate · <b>Q</b> rotate back · <b>S</b> soft drop'
    : '<b>← / →</b> move · <b>↑ / X</b> rotate · <b>Z</b> rotate back · <b>↓</b> soft drop')
    + ' · <b>Space</b> hard drop · <b>C / Shift</b> save piece (or swap with the saved one)<br><b>1–6</b> fire your next special at that numbered player (your own number = yourself) · <b>'
    + (w ? 'X' : 'D') + '</b> discard · or click a board · change keys in ⚙ Settings';
}
let dropAcc = 0, lockAcc = 0, lockResets = 0, lastTime = 0, sendPending = false;

const $ = id => document.getElementById(id);
// canvas colors follow the CSS theme variables; re-read whenever the theme changes
let theme = {};
function readTheme() { const cs = getComputedStyle(document.documentElement); theme = { well: cs.getPropertyValue('--well').trim(), grid: cs.getPropertyValue('--grid').trim() }; renderOpps(); }
const ctx = $('board').getContext('2d');
const nctx = $('next').getContext('2d');
const hctx = $('hold').getContext('2d');

// ---------- seeded RNG / shared queue ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeQueue(seed) {
  const r = mulberry32(seed); let bag = [];
  return { list: [], next() { while (this.list.length < 4) { if (!bag.length) { bag = [0,1,2,3,4,5,6]; for (let i = 6; i > 0; i--) { const j = (r() * (i + 1)) | 0; [bag[i], bag[j]] = [bag[j], bag[i]]; } } this.list.push(bag.pop()); } return this.list.shift(); } };
}

// ---------- board helpers ----------
const emptyRow = () => Array(W).fill('.');
const newBoard = () => Array.from({ length: H }, emptyRow);
const isSpecial = c => SPECIALS[c] !== undefined;
const serialize = b => b.map(r => r.join('')).join('');
const deserialize = s => { const b = newBoard(); if (s && s.length === W * H) for (let i = 0; i < W * H; i++) b[(i / W) | 0][i % W] = s[i]; return b; };
const rotate = m => m[0].map((_, i) => m.map(r => r[i]).reverse());

function spawn(idx = queue.next()) {
  const [id, m] = PIECES[idx];
  piece = { idx, id, m, x: ((W - m[0].length) / 2) | 0, y: id === '1' ? -1 : 0 };
  lockAcc = 0; lockResets = 0;
  if (collides(piece.m, piece.x, piece.y)) die();
}
function hold() {
  // Save the current piece. If one was already saved, bring it back out (from the top) and save the current one instead.
  if (holdUsed) return;
  const cur = piece.idx;
  if (held === null) spawn(); else spawn(held);
  held = cur; holdUsed = true;
}
function collides(m, px, py) {
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
    if (!m[y][x]) continue;
    const bx = px + x, by = py + y;
    if (bx < 0 || bx >= W || by >= H) return true;
    if (by >= 0 && board[by][bx] !== '.') return true;
  }
  return false;
}
function tryMove(dx, dy) {
  if (collides(piece.m, piece.x + dx, piece.y + dy)) return false;
  piece.x += dx; piece.y += dy;
  if (lockResets < 15 && lockAcc > 0) { lockAcc = 0; lockResets++; }
  return true;
}
function tryRotate(dir) {
  let m = rotate(piece.m); if (dir < 0) m = rotate(rotate(m));
  for (const [kx, ky] of [[0,0],[-1,0],[1,0],[-2,0],[2,0],[0,-1],[-1,-1],[1,-1]]) {
    if (!collides(m, piece.x + kx, piece.y + ky)) { piece.m = m; piece.x += kx; piece.y += ky; if (lockResets < 15) { lockAcc = 0; lockResets++; } return; }
  }
}
function lock() {
  let over = false;
  piece.m.forEach((r, y) => r.forEach((v, x) => { if (v) { const by = piece.y + y; if (by < 0) over = true; else board[by][piece.x + x] = piece.id; } }));
  if (over) return die();
  const n = clearLines(true);
  if (n) net({ t: 'lines', count: n }); // server counts every clear (solo score) and sends garbage for 2+
  // daily run: stop the moment you reach the goal; the server times it and sends the result
  if (dailyRun && lines >= dailyRun.goal && playing) { playing = false; piece = null; dailyDone = performance.now(); setStatus(`Done in ${fmtTime(dailyDone - countdownEnd)}! Checking the time…`); }
  holdUsed = false;
  spawn();
  syncBoard();
}
function clearLines(collect) {
  let n = 0; const got = [];
  for (let y = H - 1; y >= 0; y--) {
    if (board[y].every(c => c !== '.')) {
      for (const c of board[y]) if (isSpecial(c)) got.push(c);
      board.splice(y, 1); board.unshift(emptyRow()); n++; y++;
    }
  }
  if (n && collect) {
    // a 3- or 4-line clear collects each special twice; the hand holds 5, oldest fall off first
    for (const c of got) for (let k = 0; k < (n >= 3 ? 2 : 1); k++) inventory.push(c);
    if (inventory.length > MAX_INV) inventory.splice(0, inventory.length - MAX_INV);
    lines += n; level = 1 + Math.floor(lines / 10); renderInv(); updateStats();
  }
  return n;
}
function garbageRow(withSpecials, chance = 0.7) {
  const row = Array(W).fill('8');
  row[(Math.random() * W) | 0] = '.';
  if (withSpecials && Math.random() < chance) {
    const count = Math.random() < 0.25 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const filled = row.map((c, x) => c === '8' ? x : -1).filter(x => x >= 0);
      row[filled[(Math.random() * filled.length) | 0]] = randomSpecial();
    }
  }
  return row;
}
function randomSpecial(keys = SP_KEYS) {
  const total = keys.reduce((s, k) => s + SPECIALS[k][3], 0);
  let r = Math.random() * total;
  for (const k of keys) { r -= SPECIALS[k][3]; if (r < 0) return k; }
  return keys[0];
}
const BONUS_KEYS = SP_KEYS.filter(k => !'ACDH'.includes(k)); // first 4-line clear reward pool
function addGarbage(count, withSpecials, chance) {
  for (let i = 0; i < count; i++) {
    const top = board.shift();
    if (top.some(c => c !== '.')) { board.unshift(top); return die(); }
    board.push(garbageRow(withSpecials, chance));
  }
  fixPiece();
}
function fixPiece() { // keep active piece out of blocks after the board changes under it
  if (!piece) return;
  let tries = 0;
  while (collides(piece.m, piece.x, piece.y) && tries++ < H) piece.y--;
}

// ---------- specials ----------
const stack = (until, ms) => Math.max(until, performance.now()) + ms;
let darkStart = 0;
function applySpecial(s) {
  switch (s) {
    case 'A': addGarbage(1, false); break;
    case 'C': board.pop(); board.unshift(emptyRow()); break;
    case 'N': board = newBoard(); break;
    case 'R': {
      const filled = []; board.forEach((r, y) => r.forEach((c, x) => c !== '.' && filled.push([x, y])));
      for (let i = 0; i < 8 && filled.length; i++) { const [x, y] = filled.splice((Math.random() * filled.length) | 0, 1)[0]; board[y][x] = '.'; }
      break;
    }
    case 'Q':
      board = board.map(r => { const s = ((Math.random() * 5) | 0) - 2; return r.map((_, x) => r[(x - s + W) % W]); });
      break;
    case 'G':
      for (let x = 0; x < W; x++) { const col = []; for (let y = 0; y < H; y++) if (board[y][x] !== '.') col.push(board[y][x]); for (let y = H - 1; y >= 0; y--) board[y][x] = col.length ? col.pop() : '.'; }
      clearLines(false);
      break;
    case 'B': { // turn 3 random special blocks into plain junk
      const sp = []; board.forEach((r, y) => r.forEach((c, x) => isSpecial(c) && sp.push([x, y])));
      for (let i = 0; i < 3 && sp.length; i++) { const [x, y] = sp.splice((Math.random() * sp.length) | 0, 1)[0]; board[y][x] = '8'; }
      break;
    }
    // timed specials stack: a second one adds its full time to whatever is left
    case 'H': hasteUntil = stack(hasteUntil, 10000); break;
    case 'D': if (darkUntil < performance.now()) darkStart = performance.now(); darkUntil = stack(darkUntil, DARKNESS_MS); break;
    case 'I': invertUntil = stack(invertUntil, INVERT_MS); break;
  }
  if (playing) { fixPiece(); syncBoard(); }
}
function useSpecial(num) {
  if (!playing || !inventory.length || countingDown()) return;
  const target = ordered()[num - 1];
  if (!target || !target.alive) return;
  const s = inventory.shift();
  renderInv();
  net({ t: 'special', special: s, slot: target.slot });
}

// ---------- game loop ----------
function gravityMs() {
  let ms = Math.max(70, 800 - (level - 1) * 70);
  if (performance.now() < hasteUntil) ms /= 3;
  return ms;
}
function frame(t) {
  const dt = Math.min(100, t - lastTime); lastTime = t;
  if (playing && piece && !countingDown()) {
    dropAcc += dt;
    if (dropAcc >= gravityMs()) { dropAcc = 0; if (!collides(piece.m, piece.x, piece.y + 1)) piece.y++; }
    if (collides(piece.m, piece.x, piece.y + 1)) { lockAcc += dt; if (lockAcc >= 500) lock(); }
    else lockAcc = 0;
  }
  draw();
  renderEffects();
  if (dailyRun && playing && !countingDown()) { // live timer while a daily run is on
    const txt = `Daily run: ${Math.min(lines, dailyRun.goal)}/${dailyRun.goal} lines · ${fmtTime(performance.now() - countdownEnd)}`;
    if ($('status').textContent !== txt) setStatus(txt);
  }
  requestAnimationFrame(frame);
}
// timed effects on you, as pills beside your specials hand; the last 3 s blink so you notice it's ending.
// (Darkness isn't listed: you can see it, and a timer would give away when the board comes back.)
let lastFx = '';
function renderEffects() {
  const t = performance.now(), out = [];
  if (playing && hasteUntil > t) out.push(['Haste', '#ff66d9', hasteUntil - t]);
  if (playing && invertUntil > t) out.push(['Inverted', '#19d3b5', invertUntil - t]);
  const html = out.map(([n, c, left]) => `<span class="${left < 3000 && Math.floor(t / 250) % 2 ? 'off' : ''}" style="background:${c}">${n} ${Math.ceil(left / 1000)}</span>`).join('');
  if (html !== lastFx) { lastFx = html; $('fx').innerHTML = html; }
}
function die() {
  if (!playing) return;
  playing = false; piece = null;
  board = board.map(r => r.map(c => c === '.' ? '.' : '8'));
  syncBoard();
  net({ t: 'dead' });
  setStatus('You topped out!');
}
function startGame(seed) {
  board = newBoard(); queue = makeQueue(seed); inventory = []; lines = 0; level = 1; hasteUntil = 0; darkUntil = 0; invertUntil = 0;
  held = null; holdUsed = false;
  playing = true; dropAcc = 0; countdownEnd = performance.now() + COUNTDOWN_MS; spawn(); renderInv(); updateStats(); syncBoard();
  boards.clear();
  setStatus('');
}
function syncBoard() { // throttle board broadcasts to one per frame
  if (sendPending) return; sendPending = true;
  requestAnimationFrame(() => { sendPending = false; if (board) net({ t: 'board', cells: serialize(board) }); renderOpps(); });
}

// ---------- drawing ----------
function drawCell(c, x, y, size, cx, alpha = 1) {
  if (c === '.') return;
  cx.globalAlpha = alpha;
  const sp = isSpecial(c);
  cx.fillStyle = sp ? SPECIALS[c][1] : COLORS[c];
  cx.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
  if (sp) { cx.strokeStyle = 'rgba(0,0,0,.35)'; cx.lineWidth = 1; cx.strokeRect(x * size + 1.5, y * size + 1.5, size - 3, size - 3); }
  if (!sp && size > 12) { cx.fillStyle = 'rgba(255,255,255,.18)'; cx.fillRect(x * size + 1, y * size + 1, size - 2, 4); }
  if (sp) {
    cx.fillStyle = SPECIALS[c][4] || '#111'; cx.font = `bold ${Math.floor(size * 0.65)}px system-ui`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(c, x * size + size / 2, y * size + size / 2 + 1);
  }
  cx.globalAlpha = 1;
}
function fitBoard() { // match the canvas pixels to its on-screen size so the big board stays sharp
  const c = $('board'), r = c.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1, w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  ctx.setTransform(w / (W * CELL), 0, 0, h / (H * CELL), 0, 0);
}
function draw() {
  fitBoard();
  ctx.fillStyle = theme.well; ctx.fillRect(0, 0, W * CELL, H * CELL);
  ctx.strokeStyle = theme.grid; ctx.lineWidth = 1;
  for (let x = 1; x < W; x++) { ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H * CELL); ctx.stroke(); }
  if (!board) return;
  board.forEach((r, y) => r.forEach((c, x) => drawCell(c, x, y, CELL, ctx)));
  if (piece && !countingDown()) {
    let gy = piece.y; while (!collides(piece.m, piece.x, gy + 1)) gy++;
    piece.m.forEach((r, y) => r.forEach((v, x) => { if (v) drawCell(piece.id, piece.x + x, gy + y, CELL, ctx, 0.2); }));
    piece.m.forEach((r, y) => r.forEach((v, x) => { if (v) drawCell(piece.id, piece.x + x, piece.y + y, CELL, ctx); }));
  }
  if (performance.now() < hasteUntil) { ctx.fillStyle = 'rgba(255,102,217,.08)'; ctx.fillRect(0, 0, W * CELL, H * CELL); }
  // Darkness: black out the stack and ghost (fades in/out), leaving only a faint outline of the falling piece
  const dark = darkUntil - performance.now();
  if (playing && dark > 0) {
    const a = Math.min(1, (performance.now() - darkStart) / 250, dark / 400); // fade in from when it started
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W * CELL, H * CELL); ctx.restore();
    if (piece) piece.m.forEach((r, y) => r.forEach((v, x) => { if (v) drawCell(piece.id, piece.x + x, piece.y + y, CELL, ctx, 0.3); }));
  }
  // Inverted: teal tint, a flipped arrow and a countdown so the victim knows why nothing works
  const inv = invertUntil - performance.now();
  if (playing && inv > 0) {
    ctx.fillStyle = 'rgba(25,211,181,.13)'; ctx.fillRect(0, 0, W * CELL, H * CELL);
    // label sits a quarter of the way down, clear of where new pieces appear
    ctx.save(); ctx.globalAlpha = 0.85; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '900 30px system-ui';
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.55)'; const t = `⇄ INVERTED ${Math.ceil(inv / 1000)}`, ty = H * CELL * 0.27;
    ctx.strokeText(t, W * CELL / 2, ty); ctx.fillStyle = '#19d3b5'; ctx.fillText(t, W * CELL / 2, ty); ctx.restore();
  }
  // 3-2-1 countdown, then a brief GO!
  const left = countdownEnd - performance.now();
  if (playing && left > -600) {
    const label = left > 0 ? String(Math.ceil(left / 1000)) : 'GO!';
    const frac = left > 0 ? (left % 1000) / 1000 : (left + 600) / 600; // fades/shrinks within each second
    if (left > 0) { ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W * CELL, H * CELL); }
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.25 + frac);
    ctx.font = `900 ${Math.round((label === 'GO!' ? 90 : 150) * (0.8 + 0.3 * frac))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(label, W * CELL / 2, H * CELL / 2);
    ctx.fillStyle = label === 'GO!' ? '#4cde6c' : '#ffcc33'; ctx.fillText(label, W * CELL / 2, H * CELL / 2);
    ctx.restore();
  }
  // saved piece (dimmed once it has been used for this piece)
  hctx.clearRect(0, 0, 100, 70);
  if (held !== null && playing) {
    const [id, m] = PIECES[held]; const s = 22, rows = m.filter(r => r.some(v => v)), oy = (70 - rows.length * s) / 2 - m.indexOf(rows[0]) * s;
    hctx.save(); hctx.translate((100 - m[0].length * s) / 2, oy);
    m.forEach((r, y) => r.forEach((v, x) => { if (v) drawCell(id, x, y, s, hctx, holdUsed ? 0.35 : 1); }));
    hctx.restore();
  }
  // next pieces (same for everyone)
  nctx.clearRect(0, 0, 100, 204);
  if (queue && playing) queue.list.slice(0, 3).forEach((pi, i) => {
    const [id, m] = PIECES[pi]; const s = 22, ox = (100 - m[0].length * s) / 2;
    m.forEach((r, y) => r.forEach((v, x) => { if (v) { nctx.save(); nctx.translate(ox, 10 + i * 66); drawCell(id, x, y, s, nctx); nctx.restore(); } }));
  });
}
function renderOpps() {
  const wrap = $('opponents');
  const others = ordered().slice(1);
  if (wrap.children.length !== others.length || [...wrap.children].some((el, i) => +el.dataset.id !== others[i].id)) {
    wrap.innerHTML = '';
    for (const p of others) {
      const el = document.createElement('div');
      el.className = 'opp'; el.dataset.id = p.id;
      el.innerHTML = `<div class="name">${badge(numOf(p), true)}<span class="nm">${esc(p.name)}</span><span class="tm"></span><span class="w"></span></div><canvas width="${W * 14}" height="${H * 14}"></canvas>`;
      el.onclick = () => useSpecial(numOf(players.find(q => q.id === p.id)));
      wrap.appendChild(el);
    }
  }
  for (const el of wrap.children) {
    const p = players.find(q => q.id === +el.dataset.id);
    el.classList.toggle('dead', roomState === 'playing' && !p.alive);
    el.classList.toggle('team-red', p.team === 'red'); el.classList.toggle('team-blue', p.team === 'blue');
    el.querySelector('.tm').innerHTML = teamTag(p.team);
    el.querySelector('.w').textContent = p.wins ? `${p.wins}★` : '';
    const cx = el.querySelector('canvas').getContext('2d');
    cx.fillStyle = theme.well; cx.fillRect(0, 0, W * 14, H * 14);
    const b = deserialize(boards.get(p.id));
    b.forEach((r, y) => r.forEach((c, x) => drawCell(c, x, y, 14, cx)));
  }
}
function renderInv() {
  const el = $('inv'); el.innerHTML = '';
  // always show all 5 slots above the board so it's clear how full the hand is; slot 1 is fired next
  for (let i = 0; i < MAX_INV; i++) {
    const s = inventory[i], d = document.createElement('div');
    if (s) { d.className = 'sp' + (i === 0 ? ' first' : ''); d.style.background = SPECIALS[s][1]; d.style.color = SPECIALS[s][4] || ''; d.textContent = s; d.title = SPECIALS[s][0]; }
    else d.className = 'sp empty';
    el.appendChild(d);
  }
}
function renderPlayers() {
  const me = players.find(p => p.id === myId);
  $('mySlot').innerHTML = me ? `${badge(1, true)}<span class="nm">${esc(me.name)}</span>${teamTag(me.team)}` : '';
  $('playerList').innerHTML = ordered().map(p => `<div class="${roomState === 'playing' && !p.alive ? 'dead' : ''}"><span>${badge(numOf(p))} ${esc(p.name)}${p.id === hostId ? ' 👑' : ''}${p.id === myId ? ' (you)' : ''} ${teamTag(p.team)}</span><span>${p.wins ? p.wins + '★' : ''}</span></div>`).join('');
  const hostInLobby = myId === hostId && roomState === 'lobby';
  $('startBtn').classList.toggle('hidden', !hostInLobby);
  const teamReady = teamMode && players.length >= 2; // team mode with one player is just a solo run
  $('startBtn').textContent = dailyRoom ? 'Play again' : players.length === 1 ? 'Start solo run' : teamReady ? 'Start team game' : 'Start game';
  $('teamBtn').classList.toggle('hidden', !hostInLobby || dailyRoom);
  $('teamBtn').textContent = teamMode ? 'Team mode: ON (switch to free-for-all)' : 'Switch to team mode';
  $('teamBtn').classList.toggle('on', teamMode);
  $('modeInfo').textContent = roomState !== 'lobby' ? '' : teamReady ? 'Next game: Red vs Blue (teams picked at random)'
    : teamMode ? 'Team mode needs 2+ players; starting now is a solo run' : '';
  renderOpps();
}
function updateStats() { $('lines').textContent = lines; $('level').textContent = level; }
function setStatus(s) { $('status').textContent = s; }
function addLine(d) {
  const l = $('log'), atBottom = l.scrollHeight - l.scrollTop - l.clientHeight < 30;
  l.appendChild(d); while (l.children.length > 150) l.firstChild.remove();
  if (atBottom) l.scrollTop = l.scrollHeight; // don't yank the view if someone scrolled up to read
}
function log(msg) { const d = document.createElement('div'); d.className = 'ev'; d.textContent = msg; addLine(d); }
function chatLine(id, msg) {
  const p = players.find(q => q.id === id), d = document.createElement('div'); d.className = 'msg';
  d.innerHTML = `${p ? badge(numOf(p)) : ''}<span class="who"${p ? ` style="color:${SLOT_COLORS[numOf(p)]}"` : ''}>${esc(p ? p.name : '?')}</span>`;
  d.appendChild(document.createTextNode(msg)); addLine(d);
}
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nameOf = id => (players.find(p => p.id === id) || {}).name || '?';
function flash(id) { const el = document.querySelector(`.opp[data-id="${id}"]`); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }

// ---------- networking ----------
function net(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect(name, room, isDaily = false) {
  dailyRoom = isDaily;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => net({ t: 'join', name, room, bid: SW.bid, daily: isDaily });
  ws.onclose = () => { setStatus('Disconnected from server.'); playing = false; };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'error': $('joinErr').textContent = m.msg; break;
      case 'welcome':
        myId = m.id; $('roomName').textContent = dailyRoom ? 'daily run' : m.room;
        $('join').classList.add('hidden'); $('game').classList.remove('hidden');
        $('swBar').appendChild($('themeBar')); // ⚙ Settings sits at the end of the game's top bar, like Blockwar
        board = newBoard(); renderInv(); setStatus('Waiting for the host to start…');
        break;
      case 'lobby':
        if (!!m.teamMode !== teamMode && m.state === 'lobby' && !playing) setStatus(''); // mode switched: last result no longer applies
        players = m.players; hostId = m.hostId; roomState = m.state; teamMode = !!m.teamMode; renderPlayers();
        if (roomState === 'lobby' && !playing) setStatus($('status').textContent || 'Waiting for the host to start…');
        break;
      case 'start':
        players = m.players; roomState = 'playing'; renderPlayers();
        soloRun = m.players.length === 1; dailyRun = m.daily || null; dailyDone = 0;
        log(dailyRun ? '— Daily run started —' : soloRun ? '— Solo run started —' : '— Game started —'); startGame(m.seed);
        if (dailyRun) setStatus(`Daily run: clear ${dailyRun.goal} lines as fast as you can.`);
        else if (m.players.length === 1) setStatus('Solo run: clear as many lines as you can. It speeds up every 10 lines.');
        break;
      case 'board': boards.set(m.id, m.cells); renderOpps(); break;
      case 'garbage': if (playing) { addGarbage(m.count, true, m.rich ? 0.95 : 0.7); syncBoard(); } break; // rich: a teammate's line, nearly always has a special
      case 'special': if (playing) applySpecial(m.special); break;
      case 'setboard': if (playing) { board = deserialize(m.cells); fixPiece(); syncBoard(); } break;
      case 'used': {
        const sp = SPECIALS[m.special];
        log(`${nameOf(m.from)} → ${m.from === m.to ? 'self' : nameOf(m.to)}: ${sp ? sp[0] : m.special}`);
        flash(m.to);
        break;
      }
      case 'dead': { const p = players.find(q => q.id === m.id); if (p) p.alive = false; log(`${nameOf(m.id)} is out`); renderPlayers(); break; }
      case 'gameover':
        playing = false; piece = null; roomState = 'lobby';
        if ('winnerTeam' in m) { // team match
          const mine = (players.find(p => p.id === myId) || {}).team;
          const name = m.winnerTeam === 'red' ? 'Red team' : m.winnerTeam === 'blue' ? 'Blue team' : null;
          setStatus(!name ? 'Game over' : m.winnerTeam === mine ? `🏆 ${name} wins! (your team)` : `${name} wins!`);
          log(name ? `— ${name} wins —` : '— Game over —');
        } else {
          if (!soloRun) setStatus(m.winnerId === myId ? '🏆 You win!' : m.winnerName ? `${m.winnerName} wins!` : 'Game over');
          log(m.winnerName ? `— ${m.winnerName} wins —` : '— Game over —');
        }
        break;
      case 'log': log(m.msg); break;
      case 'chat': chatLine(m.id, m.msg); break;
      case 'bonus': if (playing) {
        const s = randomSpecial(BONUS_KEYS);
        inventory.push(s); if (inventory.length > MAX_INV) inventory.splice(0, inventory.length - MAX_INV);
        renderInv(); log(`Bonus for the first 4-line clear: ${SPECIALS[s][0]}`);
      } break;
      case 'daily': { // the server's official result for a daily run
        const msg = m.failed ? `Daily run over: topped out at ${m.lines}/${dailyRun ? dailyRun.goal : 40} lines. Press Play again to retry.`
          : m.error ? `Daily run: ${fmtTime(m.ms)} (not saved, please try again later).`
          : `Daily run: ${fmtTime(m.ms)}! ` + (m.prevBest && m.ms >= m.prevBest ? `Your best today is still ${fmtTime(m.prevBest)}. ` : m.prevBest ? 'New personal best for today! ' : '')
            + (m.onBoard ? `You're #${m.rank} on today's board.` : `Rank #${m.rank} today.`);
        dailyRun = null; setStatus(msg); log(msg);
        break;
      }
      case 'solo': {
        const nl = n => `${n} line${n === 1 ? '' : 's'}`;
        // the yellow result line says whether this run made the leaderboard
        const msg = !m.lines ? 'Solo run over: no lines cleared'
          : `Solo run over: ${nl(m.lines)}. ` + (!m.error && !m.onBoard && m.best > m.prevBest ? 'New personal best! ' : '') + SW.leaderboardText(m, 'lines');
        setStatus(msg); log(msg);
        break;
      }
    }
  };
}

// ---------- input ----------
document.addEventListener('keydown', e => {
  if (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === 'Enter' && !$('game').classList.contains('hidden')) { $('chat').focus(); e.preventDefault(); return; }
  if (/^[1-6]$/.test(e.key)) { useSpecial(+e.key); return; }
  if (!playing || !piece || countingDown()) return;
  // the chosen scheme turns keys into actions; Inverted swaps those actions around
  let act = scheme()[e.key.length === 1 ? e.key.toLowerCase() : e.key] || { c: 'hold', Shift: 'hold', ' ': 'hardDrop' }[e.key.length === 1 && e.key !== ' ' ? e.key.toLowerCase() : e.key];
  if (performance.now() < invertUntil) act = INVERT[act] || act;
  switch (act) {
    case 'left': tryMove(-1, 0); break;
    case 'right': tryMove(1, 0); break;
    case 'soft': if (tryMove(0, 1)) dropAcc = 0; break;
    case 'rotate': case 'rotateAlt': tryRotate(1); break;
    case 'rotateBack': tryRotate(-1); break;
    case 'hold': hold(); break;
    case 'hardDrop': while (tryMove(0, 1)); lock(); break;
    case 'discard': if (inventory.length) { inventory.shift(); renderInv(); } break;
    default: return;
  }
  e.preventDefault();
});
// Leaderboard for the selected game (top 10, one spot per player), plus its top 3 drifting in the background
const LB_WHAT = { stackwar: 'most lines in one solo run', snakewar: 'most food in classic solo', blockwar: 'best solo score' };
let lbGame = null;
function loadLeaderboard() {
  const g = GAMES[gameIdx].id;
  if (!SHOW_LEADERBOARD || !$('lbList')) return;
  if (g !== lbGame) { lbGame = g; $('lbList').innerHTML = '<li class="empty">Loading…</li>'; }
  $('lbWhat').textContent = LB_WHAT[g];
  fetch('/api/leaderboard?game=' + g).then(r => r.json()).then(rows => {
    if (GAMES[gameIdx].id !== g) return; // switched games while loading
    $('lbList').innerHTML = rows.length
      ? rows.map((r, i) => `<li><span class="rk">${i + 1}</span><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><b>${r.score}</b></li>`).join('')
      : '<li class="empty">No solo scores yet. Join an empty lobby and start a game to set the first one!</li>';
    renderMarquee(rows.slice(0, 3));
  }).catch(() => { $('lbList').innerHTML = '<li class="empty">Leaderboard unavailable right now.</li>'; renderMarquee([]); });
}
let lastMarquee = '';
const MARQUEE_ROWS = 9;
function renderMarquee(top) {
  // The top 3 names tile the whole background: each row cycles 1st, 2nd, 3rd (gold, silver, bronze),
  // and each row starts one name further along than the row above, so the colors checkerboard both
  // across and down. Rows drift constantly, neighbours in opposite directions. Each row's content is
  // doubled so the drift (half its width) loops seamlessly.
  const names = top.map((r, i) => `<span class="m${i + 1}">${esc(r.name)}</span>`);
  let html = '';
  if (names.length) for (let row = 0; row < MARQUEE_ROWS; row++) {
    const cells = [];
    for (let k = 0; k < 18; k++) cells.push(names[(row + k) % names.length]);
    const once = cells.join('');
    html += `<div class="row${row % 2 ? ' rev' : ''}" style="animation-duration:${70 + (row % 3) * 12}s">${once}${once}</div>`;
  }
  if (html !== lastMarquee) { lastMarquee = html; $('marquee').innerHTML = html; }
}
setInterval(() => { if (!$('join').classList.contains('hidden')) { loadLeaderboard(); loadDaily(); } }, 15000);

// ---------- homepage: Stackwar daily run board ----------
function loadDaily() {
  const show = GAMES[gameIdx].id === 'stackwar';
  $('daily').classList.toggle('hidden', !show);
  if (!show) return;
  fetch('/api/daily').then(r => r.json()).then(d => {
    $('dailyWhat').textContent = `${d.goal} lines, fastest time`;
    const h = Math.floor(d.resetsInMs / 3600000), m = Math.floor(d.resetsInMs / 60000) % 60;
    $('dailyReset').textContent = `New run in ${h ? h + 'h ' : ''}${m}m`;
    $('dailyList').innerHTML = d.top.length
      ? d.top.map((r, i) => `<li><span class="rk">${i + 1}</span><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><b>${fmtTime(r.ms)}</b></li>`).join('')
      : '<li class="empty">No times yet today. Be the first!</li>';
  }).catch(() => { $('dailyList').innerHTML = '<li class="empty">Daily run unavailable right now.</li>'; });
}
// usernames are checked (slurs, and for a lobby: someone already using it there) before joining
async function nameOk(room, game) {
  try {
    const q = new URLSearchParams({ name: $('name').value.trim(), room, game, bid: SW.bid });
    const r = await (await fetch('/api/name-ok?' + q)).json();
    if (!r.ok) { $('joinErr').textContent = r.msg; $('name').focus(); return false; }
  } catch {}
  return true;
}
$('dailyBtn').onclick = async () => {
  $('joinErr').textContent = '';
  if (!$('name').value.trim()) { $('joinErr').textContent = 'Enter a username first.'; $('name').focus(); return; }
  if (!(await nameOk('', 'stackwar'))) return;
  try { localStorage.setItem('sw-name', $('name').value.trim()); } catch {}
  connect($('name').value, '', true);
};

// ---------- homepage chat: one site-wide room that keeps its last 50 lines ----------
let hcLast = 0, hcBusy = false;
function chatTime(at) { const d = new Date(at); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function loadHomeChat() {
  if ($('join').classList.contains('hidden') || hcBusy) return; // only while the homepage is showing
  hcBusy = true;
  fetch('/api/chat?after=' + hcLast).then(r => r.json()).then(lines => {
    if (!Array.isArray(lines) || !lines.length) return;
    const log = $('hcLog'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    for (const l of lines) {
      if (l.id <= hcLast) continue;
      hcLast = l.id;
      const d = document.createElement('div');
      d.title = chatTime(l.at);
      if (l.name) { d.innerHTML = `<span class="who">${esc(l.name)}</span>`; d.appendChild(document.createTextNode(l.msg)); }
      else { d.className = 'ev'; d.textContent = l.msg; }
      log.appendChild(d);
    }
    while (log.children.length > 50) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }).catch(() => {}).finally(() => { hcBusy = false; });
}
$('hcForm').onsubmit = async e => {
  e.preventDefault();
  const msg = $('hcMsg').value.trim(); $('hcErr').textContent = '';
  if (!msg) return;
  if (!$('name').value.trim()) { $('hcErr').textContent = 'Enter a username above first.'; return; }
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bid: SW.bid, name: $('name').value.trim(), msg }) });
    const d = await r.json();
    if (!r.ok) { $('hcErr').textContent = d.error || 'Could not send.'; return; }
    $('hcMsg').value = ''; loadHomeChat();
  } catch { $('hcErr').textContent = 'Could not send.'; }
};
loadHomeChat(); setInterval(loadHomeChat, 3000);

// ---------- homepage game picker ----------
const GAMES = [{ id: 'stackwar', title: 'STACKWAR' }, { id: 'snakewar', title: 'SNAKEWAR' }, { id: 'blockwar', title: 'BLOCKWAR' }];
let gameIdx = 0;
try { gameIdx = Math.max(0, GAMES.findIndex(g => g.id === localStorage.getItem('sw-game'))); } catch {}
function showGame(dir) {
  const g = GAMES[gameIdx], t = $('titleText');
  t.textContent = g.title; t.dataset.game = g.id;
  if (dir) { t.classList.remove('slide-l', 'slide-r'); void t.offsetWidth; t.classList.add(dir < 0 ? 'slide-l' : 'slide-r'); }
  $('gameDots').innerHTML = GAMES.map((_, i) => `<span class="${i === gameIdx ? 'on' : ''}"></span>`).join('');
  $('leaderboard').classList.toggle('hidden', !SHOW_LEADERBOARD);
  loadLeaderboard(); loadDaily();
  renderLobbies();
  document.title = g.title[0] + g.title.slice(1).toLowerCase();
  try { localStorage.setItem('sw-game', g.id); } catch {}
}
// Lobby browser: who's playing what, refreshed every few seconds while the homepage is showing.
// Clicking a lobby joins it (or fills in its code if you haven't entered a name yet).
let lobbyData = null;
function renderLobbies() {
  const g = GAMES[gameIdx].id, list = $('lobbyList');
  if (!list) return;
  if (!lobbyData) return;
  const rows = (lobbyData[g] || []).slice().sort((a, b) => b.players - a.players || a.room.localeCompare(b.room));
  const total = rows.reduce((n, r) => n + r.players, 0);
  $('lobbyCount').textContent = rows.length ? `${total} playing in ${rows.length} ${rows.length === 1 ? 'lobby' : 'lobbies'}` : '';
  list.innerHTML = rows.length ? rows.map(r => `<li class="lobby" data-room="${esc(r.room)}" title="Join ${esc(r.room)}">
      <span class="lname">${esc(r.room)}${r.teamMode ? ' · teams' : ''}${r.mode ? (r.mode === 'lives' ? ' · lives' : ' · clear race') : ''}<span class="lnames">${esc(r.names.join(', '))}</span></span>
      <span class="lcount">${r.players} ${r.players === 1 ? 'player' : 'players'}</span>
      <span class="lstate ${r.playing ? 'playing' : 'waiting'}">${r.playing ? 'In game' : 'Waiting'}</span></li>`).join('')
    : '<li class="empty">Nobody is playing right now. Enter a lobby code to start one!</li>';
  for (const li of list.querySelectorAll('li.lobby')) li.onclick = () => {
    $('room').value = li.dataset.room;
    if ($('name').value.trim()) $('joinForm').requestSubmit(); else $('name').focus();
  };
}
function loadLobbies() {
  if ($('join').classList.contains('hidden')) return; // only while the homepage is showing
  fetch('/api/lobbies').then(r => r.json()).then(d => { lobbyData = d; renderLobbies(); }).catch(() => {});
}
loadLobbies(); setInterval(loadLobbies, 3000);
function pickGame(dir) { gameIdx = (gameIdx + dir + GAMES.length) % GAMES.length; showGame(dir); }
$('prevGame').onclick = () => pickGame(-1);
$('nextGame').onclick = () => pickGame(1);
document.addEventListener('keydown', e => {
  if ($('join').classList.contains('hidden') || /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, w = SW.controls() === 'wasd';
  if (k === 'ArrowLeft' || (w && k === 'a')) pickGame(-1); else if (k === 'ArrowRight' || (w && k === 'd')) pickGame(1);
});
showGame(0);
$('joinForm').onsubmit = async e => {
  e.preventDefault(); $('joinErr').textContent = '';
  // usernames with racial slurs are refused (the server checks too)
  if (!(await nameOk($('room').value.trim() || 'lobby', GAMES[gameIdx].id))) return;
  try { localStorage.setItem('sw-name', $('name').value.trim()); } catch {}
  if (GAMES[gameIdx].id === 'blockwar') { location.href = 'block.html?room=' + encodeURIComponent($('room').value.trim() || 'lobby'); return; }
  if (GAMES[gameIdx].id === 'snakewar') { location.href = 'snake.html?room=' + encodeURIComponent($('room').value.trim() || 'lobby'); return; }
  connect($('name').value, $('room').value);
};
$('startBtn').onclick = () => net({ t: 'start' });
// Leave the room for real: tell the server first (so it drops you immediately), then close.
function leaveRoom() { try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'leave' })); ws.close(); } } catch {} }
window.addEventListener('pagehide', leaveRoom); // tab closed, reloaded, browser back, or Back to lobby
// Back to the homepage (game + lobby select). Leaving mid-game counts as being knocked out, so ask first.
$('leaveBtn').onclick = e => {
  if (playing && !confirm('Leave this game? You will be counted as out.')) { e.target.blur(); return; }
  leaveRoom(); location.href = '/';
};
$('teamBtn').onclick = e => { net({ t: 'teammode', on: !teamMode }); e.target.blur(); };
$('chat').addEventListener('keydown', e => {
  // Enter sends (or just leaves the box if empty); Esc leaves without sending. Either way, focus returns to the game.
  e.stopPropagation(); // keep chat keys away from the game controls
  if (e.key === 'Enter') { if (e.target.value.trim()) net({ t: 'chat', msg: e.target.value }); e.target.value = ''; e.target.blur(); }
  else if (e.key === 'Escape') e.target.blur();
});
$('specialList').innerHTML = SP_KEYS.map(k => `<li><span class="sp" style="background:${SPECIALS[k][1]};color:${SPECIALS[k][4] || '#111'}">${k}</span><span><b>${SPECIALS[k][0]}</b> – ${SPECIALS[k][2]}</span></li>`).join('');
try { $('name').value = localStorage.getItem('sw-name') || ''; } catch {}
SW.mountSettings($('themeBar')); // ⚙ Settings: theme + controls, saved per browser
SW.onChange(() => { readTheme(); renderKeysHelp(); });
renderKeysHelp();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);
readTheme();
$('name').addEventListener('change', e => { try { localStorage.setItem('sw-name', e.target.value); } catch {} });

board = null;
requestAnimationFrame(t => { lastTime = t; frame(t); });
})();
