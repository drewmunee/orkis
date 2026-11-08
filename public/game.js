// Stackwar client
(() => {
const W = 10, H = 20, CELL = 30;
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
  R: ['Random Clear', '#7bd3ff', 'Knocks 10 random blocks out of the target board', 4],
  Q: ['Earthquake',   '#ffb347', 'Shakes every row of the target board sideways', 3],
  G: ['Gravity',      '#c8a2ff', 'Drops all blocks down, filling every hole', 1.5],
  B: ['Blank',        '#d0d0d0', 'Turns all special blocks on the target into junk', 3],
  H: ['Haste',        '#ff66d9', 'Target pieces fall 3x faster for 10 seconds', 3],
  S: ['Switch',       '#fff36b', 'Switches your whole board with the target', 0.7],
  N: ['Nuke',         '#ffffff', 'Wipes the target board completely clean', 0.7],
};
const SP_KEYS = Object.keys(SPECIALS);
const MAX_INV = 18;
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
let soloRun = false; // game started with only this player: score goes to the leaderboard
let held = null, holdUsed = false; // saved piece index; hold allowed once per piece
let inventory = [], lines = 0, level = 1, hasteUntil = 0;
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
  holdUsed = false;
  spawn();
  syncBoard();
}
function clearLines(collect) {
  let n = 0;
  for (let y = H - 1; y >= 0; y--) {
    if (board[y].every(c => c !== '.')) {
      if (collect) for (const c of board[y]) if (isSpecial(c) && inventory.length < MAX_INV) inventory.push(c);
      board.splice(y, 1); board.unshift(emptyRow()); n++; y++;
    }
  }
  if (n && collect) { lines += n; level = 1 + Math.floor(lines / 10); renderInv(); updateStats(); }
  return n;
}
function garbageRow(withSpecials) {
  const row = Array(W).fill('8');
  row[(Math.random() * W) | 0] = '.';
  if (withSpecials && Math.random() < 0.7) {
    const count = Math.random() < 0.25 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const filled = row.map((c, x) => c === '8' ? x : -1).filter(x => x >= 0);
      row[filled[(Math.random() * filled.length) | 0]] = randomSpecial();
    }
  }
  return row;
}
function randomSpecial() {
  const total = SP_KEYS.reduce((s, k) => s + SPECIALS[k][3], 0);
  let r = Math.random() * total;
  for (const k of SP_KEYS) { r -= SPECIALS[k][3]; if (r < 0) return k; }
  return 'A';
}
function addGarbage(count, withSpecials) {
  for (let i = 0; i < count; i++) {
    const top = board.shift();
    if (top.some(c => c !== '.')) { board.unshift(top); return die(); }
    board.push(garbageRow(withSpecials));
  }
  fixPiece();
}
function fixPiece() { // keep active piece out of blocks after the board changes under it
  if (!piece) return;
  let tries = 0;
  while (collides(piece.m, piece.x, piece.y) && tries++ < H) piece.y--;
}

// ---------- specials ----------
function applySpecial(s) {
  switch (s) {
    case 'A': addGarbage(1, false); break;
    case 'C': board.pop(); board.unshift(emptyRow()); break;
    case 'N': board = newBoard(); break;
    case 'R': {
      const filled = []; board.forEach((r, y) => r.forEach((c, x) => c !== '.' && filled.push([x, y])));
      for (let i = 0; i < 10 && filled.length; i++) { const [x, y] = filled.splice((Math.random() * filled.length) | 0, 1)[0]; board[y][x] = '.'; }
      break;
    }
    case 'Q':
      board = board.map(r => { const s = ((Math.random() * 5) | 0) - 2; return r.map((_, x) => r[(x - s + W) % W]); });
      break;
    case 'G':
      for (let x = 0; x < W; x++) { const col = []; for (let y = 0; y < H; y++) if (board[y][x] !== '.') col.push(board[y][x]); for (let y = H - 1; y >= 0; y--) board[y][x] = col.length ? col.pop() : '.'; }
      clearLines(false);
      break;
    case 'B': board = board.map(r => r.map(c => isSpecial(c) ? '8' : c)); break;
    case 'H': hasteUntil = performance.now() + 10000; break;
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
  requestAnimationFrame(frame);
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
  board = newBoard(); queue = makeQueue(seed); inventory = []; lines = 0; level = 1; hasteUntil = 0;
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
    cx.fillStyle = '#111'; cx.font = `bold ${Math.floor(size * 0.65)}px system-ui`;
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
      el.innerHTML = `<div class="name">${badge(numOf(p), true)}<span class="nm">${esc(p.name)}</span><span class="w"></span></div><canvas width="${W * 14}" height="${H * 14}"></canvas>`;
      el.onclick = () => useSpecial(numOf(players.find(q => q.id === p.id)));
      wrap.appendChild(el);
    }
  }
  for (const el of wrap.children) {
    const p = players.find(q => q.id === +el.dataset.id);
    el.classList.toggle('dead', roomState === 'playing' && !p.alive);
    el.querySelector('.w').textContent = p.wins ? `${p.wins}★` : '';
    const cx = el.querySelector('canvas').getContext('2d');
    cx.fillStyle = theme.well; cx.fillRect(0, 0, W * 14, H * 14);
    const b = deserialize(boards.get(p.id));
    b.forEach((r, y) => r.forEach((c, x) => drawCell(c, x, y, 14, cx)));
  }
}
function renderInv() {
  const el = $('inv'); el.innerHTML = '';
  inventory.forEach((s, i) => { const d = document.createElement('div'); d.className = 'sp' + (i === 0 ? ' first' : ''); d.style.background = SPECIALS[s][1]; d.textContent = s; d.title = SPECIALS[s][0]; el.appendChild(d); });
  $('invHelp').textContent = inventory.length ? `Next: ${SPECIALS[inventory[0]][0]} — ${SPECIALS[inventory[0]][2]}` : 'Clear lines containing lettered blocks to collect specials.';
}
function renderPlayers() {
  const me = players.find(p => p.id === myId);
  $('mySlot').innerHTML = me ? `${badge(1, true)} ${esc(me.name)}` : '';
  renderTargets();
  $('playerList').innerHTML = ordered().map(p => `<div class="${roomState === 'playing' && !p.alive ? 'dead' : ''}"><span>${badge(numOf(p))} ${esc(p.name)}${p.id === hostId ? ' 👑' : ''}${p.id === myId ? ' (you)' : ''}</span><span>${p.wins ? p.wins + '★' : ''}</span></div>`).join('');
  $('startBtn').classList.toggle('hidden', !(myId === hostId && roomState === 'lobby'));
  renderOpps();
}
function renderTargets() {
  $('targets').innerHTML = ordered().map((p, i) => `<button class="tgt${roomState === 'playing' && !p.alive ? ' dead' : ''}" data-num="${i + 1}" style="border-color:${SLOT_COLORS[i + 1]}">${badge(i + 1)} ${p.id === myId ? 'You' : esc(p.name)}</button>`).join('');
  for (const b of $('targets').children) b.onclick = () => useSpecial(+b.dataset.num);
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
function connect(name, room) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => net({ t: 'join', name, room });
  ws.onclose = () => { setStatus('Disconnected from server.'); playing = false; };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'error': $('joinErr').textContent = m.msg; break;
      case 'welcome':
        myId = m.id; $('roomName').textContent = m.room;
        $('join').classList.add('hidden'); $('game').classList.remove('hidden');
        board = newBoard(); renderInv(); setStatus('Waiting for the host to start…');
        break;
      case 'lobby':
        players = m.players; hostId = m.hostId; roomState = m.state; renderPlayers();
        if (roomState === 'lobby' && !playing) setStatus($('status').textContent || 'Waiting for the host to start…');
        break;
      case 'start':
        players = m.players; roomState = 'playing'; renderPlayers();
        soloRun = m.players.length === 1;
        log(soloRun ? '— Solo run started —' : '— Game started —'); startGame(m.seed);
        if (m.players.length === 1) setStatus('Solo run: clear as many lines as you can. It speeds up every 10 lines.');
        break;
      case 'board': boards.set(m.id, m.cells); renderOpps(); break;
      case 'garbage': if (playing) { addGarbage(m.count, true); syncBoard(); } break;
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
        if (!soloRun) setStatus(m.winnerId === myId ? '🏆 You win!' : m.winnerName ? `${m.winnerName} wins!` : 'Game over');
        log(m.winnerName ? `— ${m.winnerName} wins —` : '— Game over —');
        break;
      case 'log': log(m.msg); break;
      case 'chat': chatLine(m.id, m.msg); break;
      case 'solo': {
        const nl = n => `${n} line${n === 1 ? '' : 's'}`;
        const msg = m.error ? `Solo run over: ${nl(m.lines)} (couldn't save to the leaderboard)`
          : !m.lines ? 'Solo run over: no lines cleared'
          : m.lines >= m.best ? `Solo run over: ${nl(m.lines)}, a personal best! #${m.rank} on the leaderboard`
          : `Solo run over: ${nl(m.lines)}. Your best is ${m.best} (#${m.rank} on the leaderboard)`;
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
  switch (e.key) {
    case 'ArrowLeft': tryMove(-1, 0); break;
    case 'ArrowRight': tryMove(1, 0); break;
    case 'ArrowDown': if (tryMove(0, 1)) dropAcc = 0; break;
    case 'ArrowUp': case 'x': case 'X': tryRotate(1); break;
    case 'z': case 'Z': tryRotate(-1); break;
    case 'c': case 'C': case 'Shift': hold(); break;
    case ' ': while (tryMove(0, 1)); lock(); break;
    case 'd': case 'D': if (inventory.length) { inventory.shift(); renderInv(); } break;
    default: return;
  }
  e.preventDefault();
});
$('joinForm').onsubmit = e => { e.preventDefault(); $('joinErr').textContent = ''; connect($('name').value, $('room').value); };
$('startBtn').onclick = () => net({ t: 'start' });
function loadLeaderboard() {
  fetch('/api/leaderboard').then(r => r.json()).then(rows => {
    $('lbList').innerHTML = rows.length
      ? rows.map((r, i) => `<li><span class="rk">${i + 1}</span><span class="nm">${esc(r.name)}</span><b>${r.lines}</b></li>`).join('')
      : '<li class="empty">No solo runs yet. Join an empty room and press Start to set the first score.</li>';
  }).catch(() => { $('lbList').innerHTML = '<li class="empty">Leaderboard unavailable right now.</li>'; });
}
loadLeaderboard();
$('chat').addEventListener('keydown', e => {
  // Enter sends (or just leaves the box if empty); Esc leaves without sending. Either way, focus returns to the game.
  e.stopPropagation(); // keep chat keys away from the game controls
  if (e.key === 'Enter') { if (e.target.value.trim()) net({ t: 'chat', msg: e.target.value }); e.target.value = ''; e.target.blur(); }
  else if (e.key === 'Escape') e.target.blur();
});
$('specialList').innerHTML = SP_KEYS.map(k => `<li><span class="sp" style="background:${SPECIALS[k][1]}">${k}</span><b>${SPECIALS[k][0]}</b> — ${SPECIALS[k][2]}</li>`).join('');
try { $('name').value = localStorage.getItem('sw-name') || ''; } catch {}
$('theme').value = document.documentElement.dataset.theme || 'system';
$('theme').addEventListener('change', e => {
  document.documentElement.dataset.theme = e.target.value;
  try { localStorage.setItem('sw-theme', e.target.value); } catch {}
  readTheme(); e.target.blur();
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);
readTheme();
$('name').addEventListener('change', e => { try { localStorage.setItem('sw-name', e.target.value); } catch {} });

board = null;
requestAnimationFrame(t => { lastTime = t; frame(t); });
})();
