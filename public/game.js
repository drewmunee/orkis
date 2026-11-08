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
  R: ['Random Blocks', '#7bd3ff', 'Drops ~7 random junk blocks onto the target board', 4],
  Q: ['Quake',        '#ffb347', 'Shakes every row of the target board sideways', 3],
  G: ['Gravity',      '#c8a2ff', 'Drops all blocks down, filling every hole', 2],
  B: ['Blank',        '#d0d0d0', 'Turns all special blocks on the target into junk', 3],
  H: ['Haste',        '#ff66d9', 'Target pieces fall 3x faster for 10 seconds', 3],
  S: ['Switch',       '#fff36b', 'Switches your whole board with the target', 1],
  N: ['Nuke',         '#ffffff', 'Wipes the target board completely clean', 1],
};
const SP_KEYS = Object.keys(SPECIALS);
const MAX_INV = 18;
const SLOT_COLORS = ['', '#ff5470', '#30d5ff', '#4cde6c', '#ffd23f', '#b45cff', '#ff9a3c'];
const badge = (slot, big) => `<span class="slot${big ? ' big' : ''}" style="background:${SLOT_COLORS[slot]}">${slot}</span>`;

// ---------- state ----------
let ws, myId = null, hostId = null, roomState = 'lobby';
let players = [];               // from server
const boards = new Map();       // id -> cells string
let board, piece, queue, rng, playing = false;
let inventory = [], lines = 0, level = 1, hasteUntil = 0;
let dropAcc = 0, lockAcc = 0, lockResets = 0, lastTime = 0, sendPending = false;

const $ = id => document.getElementById(id);
const ctx = $('board').getContext('2d');
const nctx = $('next').getContext('2d');

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

function spawn() {
  const [id, m] = PIECES[queue.next()];
  piece = { id, m, x: ((W - m[0].length) / 2) | 0, y: id === '1' ? -1 : 0 };
  lockAcc = 0; lockResets = 0;
  if (collides(piece.m, piece.x, piece.y)) die();
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
  if (n >= 2) net({ t: 'lines', count: n });
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
  if (withSpecials && Math.random() < 0.4) {
    const count = Math.random() < 0.1 ? 2 : 1;
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
      // add ~7 junk blocks into empty cells, kept to the stack area so they don't float near the top
      let top = board.findIndex(r => r.some(c => c !== '.')); if (top < 0) top = H;
      const minY = Math.max(2, Math.min(top - 2, H - 6));
      const empty = []; for (let y = minY; y < H; y++) for (let x = 0; x < W; x++) if (board[y][x] === '.') empty.push([x, y]);
      const n = 6 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n && empty.length; i++) { const [x, y] = empty.splice((Math.random() * empty.length) | 0, 1)[0]; board[y][x] = '8'; }
      clearLines(false);
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
function useSpecial(slot) {
  if (!playing || !inventory.length) return;
  const target = players.find(p => p.slot === slot);
  if (!target || !target.alive) return;
  const s = inventory.shift();
  renderInv();
  net({ t: 'special', special: s, slot });
}

// ---------- game loop ----------
function gravityMs() {
  let ms = Math.max(70, 800 - (level - 1) * 70);
  if (performance.now() < hasteUntil) ms /= 3;
  return ms;
}
function frame(t) {
  const dt = Math.min(100, t - lastTime); lastTime = t;
  if (playing && piece) {
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
  playing = true; dropAcc = 0; spawn(); renderInv(); updateStats(); syncBoard();
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
  if (!sp && size > 12) { cx.fillStyle = 'rgba(255,255,255,.18)'; cx.fillRect(x * size + 1, y * size + 1, size - 2, 4); }
  if (sp) {
    cx.fillStyle = '#111'; cx.font = `bold ${Math.floor(size * 0.65)}px system-ui`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(c, x * size + size / 2, y * size + size / 2 + 1);
  }
  cx.globalAlpha = 1;
}
function draw() {
  ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, W * CELL, H * CELL);
  ctx.strokeStyle = '#141733';
  for (let x = 1; x < W; x++) { ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H * CELL); ctx.stroke(); }
  if (!board) return;
  board.forEach((r, y) => r.forEach((c, x) => drawCell(c, x, y, CELL, ctx)));
  if (piece) {
    let gy = piece.y; while (!collides(piece.m, piece.x, gy + 1)) gy++;
    piece.m.forEach((r, y) => r.forEach((v, x) => { if (v) drawCell(piece.id, piece.x + x, gy + y, CELL, ctx, 0.2); }));
    piece.m.forEach((r, y) => r.forEach((v, x) => { if (v) drawCell(piece.id, piece.x + x, piece.y + y, CELL, ctx); }));
  }
  if (performance.now() < hasteUntil) { ctx.fillStyle = 'rgba(255,102,217,.08)'; ctx.fillRect(0, 0, W * CELL, H * CELL); }
  // next pieces (same for everyone)
  nctx.clearRect(0, 0, 120, 240);
  if (queue && playing) queue.list.slice(0, 3).forEach((pi, i) => {
    const [id, m] = PIECES[pi]; const s = 22, ox = (120 - m[0].length * s) / 2;
    m.forEach((r, y) => r.forEach((v, x) => { if (v) { nctx.save(); nctx.translate(ox, 10 + i * 78); drawCell(id, x, y, s, nctx); nctx.restore(); } }));
  });
}
function renderOpps() {
  const wrap = $('opponents');
  const others = players.filter(p => p.id !== myId);
  if (wrap.children.length !== others.length || [...wrap.children].some((el, i) => +el.dataset.id !== others[i].id)) {
    wrap.innerHTML = '';
    for (const p of others) {
      const el = document.createElement('div');
      el.className = 'opp'; el.dataset.id = p.id;
      el.innerHTML = `<div class="name">${badge(p.slot, true)}<span class="nm">${esc(p.name)}</span><span class="w"></span></div><canvas width="${W * 14}" height="${H * 14}"></canvas>`;
      el.onclick = () => useSpecial(p.slot);
      wrap.appendChild(el);
    }
  }
  for (const el of wrap.children) {
    const p = players.find(q => q.id === +el.dataset.id);
    el.classList.toggle('dead', roomState === 'playing' && !p.alive);
    el.querySelector('.w').textContent = p.wins ? `${p.wins}★` : '';
    const cx = el.querySelector('canvas').getContext('2d');
    cx.fillStyle = '#05060f'; cx.fillRect(0, 0, W * 14, H * 14);
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
  $('mySlot').innerHTML = me ? `${badge(me.slot, true)} ${esc(me.name)}` : '';
  renderTargets();
  $('playerList').innerHTML = players.map(p => `<div class="${roomState === 'playing' && !p.alive ? 'dead' : ''}"><span>${badge(p.slot)} ${esc(p.name)}${p.id === hostId ? ' 👑' : ''}${p.id === myId ? ' (you)' : ''}</span><span>${p.wins ? p.wins + '★' : ''}</span></div>`).join('');
  $('startBtn').classList.toggle('hidden', !(myId === hostId && roomState === 'lobby'));
  renderOpps();
}
function renderTargets() {
  $('targets').innerHTML = players.map(p => `<button class="tgt${roomState === 'playing' && !p.alive ? ' dead' : ''}" data-slot="${p.slot}" style="border-color:${SLOT_COLORS[p.slot]}">${badge(p.slot)} ${p.id === myId ? 'You' : esc(p.name)}</button>`).join('');
  for (const b of $('targets').children) b.onclick = () => useSpecial(+b.dataset.slot);
}
function updateStats() { $('lines').textContent = lines; $('level').textContent = level; }
function setStatus(s) { $('status').textContent = s; }
function log(msg) { const d = document.createElement('div'); d.textContent = msg; const l = $('log'); l.appendChild(d); l.scrollTop = l.scrollHeight; while (l.children.length > 100) l.firstChild.remove(); }
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
        log('— Game started —'); startGame(m.seed);
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
        setStatus(m.winnerId === myId ? '🏆 You win!' : m.winnerName ? `${m.winnerName} wins!` : 'Game over');
        log(m.winnerName ? `— ${m.winnerName} wins —` : '— Game over —');
        break;
      case 'log': log(m.msg); break;
    }
  };
}

// ---------- input ----------
document.addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (/^[1-6]$/.test(e.key)) { useSpecial(+e.key); return; }
  if (!playing || !piece) return;
  switch (e.key) {
    case 'ArrowLeft': tryMove(-1, 0); break;
    case 'ArrowRight': tryMove(1, 0); break;
    case 'ArrowDown': if (tryMove(0, 1)) dropAcc = 0; break;
    case 'ArrowUp': case 'x': case 'X': tryRotate(1); break;
    case 'z': case 'Z': tryRotate(-1); break;
    case ' ': while (tryMove(0, 1)); lock(); break;
    case 'd': case 'D': if (inventory.length) { inventory.shift(); renderInv(); } break;
    default: return;
  }
  e.preventDefault();
});
$('joinForm').onsubmit = e => { e.preventDefault(); $('joinErr').textContent = ''; connect($('name').value, $('room').value); };
$('startBtn').onclick = () => net({ t: 'start' });
$('chat').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) { net({ t: 'chat', msg: e.target.value }); e.target.value = ''; e.target.blur(); } });
$('specialList').innerHTML = SP_KEYS.map(k => `<li><span class="sp" style="background:${SPECIALS[k][1]}">${k}</span><b>${SPECIALS[k][0]}</b> — ${SPECIALS[k][2]}</li>`).join('');
$('name').value = localStorage.getItem('sw-name') || '';
$('name').addEventListener('change', e => { try { localStorage.setItem('sw-name', e.target.value); } catch {} });

board = null;
requestAnimationFrame(t => { lastTime = t; frame(t); });
})();
