// Snakewar client: draws the server's field and sends steering input.
(() => {
const $ = id => document.getElementById(id);
const SNAKE_COLORS = ['', '#ff5470', '#30d5ff', '#4cde6c', '#ffd23f', '#b45cff', '#ff9a3c', '#3d7bff', '#ff66d9', '#7bffb0', '#c8a2ff', '#ffb347', '#a0e8ff'];
const SPECIAL_INFO = {
  speed: { name: 'Speed', icon: '⚡', color: '#ffd23f', desc: 'move twice as fast for 5 seconds' },
  ghost: { name: 'Ghost', icon: '👻', color: '#cfd8ff', desc: 'slide through snakes for 6 seconds' },
  feast: { name: 'Feast', icon: '+5', color: '#ff66d9', desc: 'grow 5 segments at once' },
  shears: { name: 'Shears', icon: '✂', color: '#ff7b7b', desc: 'every other snake loses 4 segments (never below 3)' },
  double: { name: 'Double', icon: 'x2', color: '#7bffb0', desc: 'all growth counts double for 20 seconds' },
  slow: { name: 'Slow', icon: '🐌', color: '#a0c4ff', desc: 'every other snake moves at half speed for 5 seconds' },
};
const KEYS = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', w: 'U', s: 'D', a: 'L', d: 'R', W: 'U', S: 'D', A: 'L', D: 'R' };

let name = '';
try { name = localStorage.getItem('sw-name') || ''; } catch {}
const room = new URLSearchParams(location.search).get('room') || 'lobby';
if (!name.trim()) { location.replace('/'); return; }

let ws, myId = null, hostId = null, roomState = 'lobby', GW = 112, GH = 63;
let players = [], state = { snakes: [], food: [], drops: [], specials: [] };
let countdownEnd = 0, banner = null; // banner: {text, until}

const canvas = $('field'), ctx = canvas.getContext('2d');
let theme = {};
function readTheme() { const cs = getComputedStyle(document.documentElement); theme = { well: cs.getPropertyValue('--well').trim(), grid: cs.getPropertyValue('--grid').trim(), bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() }; }

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colorOf = id => { const p = players.find(q => q.id === id); return p ? SNAKE_COLORS[p.slot] : '#888'; };
const nameOf = id => (players.find(q => q.id === id) || {}).name || '?';

// ---------- network ----------
function net(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => net({ t: 'join', game: 'snake', name, room });
  ws.onclose = () => setStatus('Disconnected. Reload to rejoin.');
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'error': setStatus(m.msg); break;
      case 'welcome': myId = m.id; GW = m.w; GH = m.h; $('roomName').textContent = m.room; break;
      case 'lobby': players = m.players; hostId = m.hostId; roomState = m.state; renderPlayers(); updateChat(); break;
      case 'start':
        players = m.players; countdownEnd = performance.now() + m.countdown; banner = null;
        setStatus(players.length === 1 ? 'Solo round: grow as long as you can' : '');
        log('— Round started —');
        break;
      case 'state': state = m; if (m.w) { GW = m.w; GH = m.h; } updateLengths(); updateChat(); break; // field size depends on player count
      case 'ate': if (m.id === myId) flashBanner(`${SPECIAL_INFO[m.special].name}!`, 900); break;
      case 'gameover': {
        const txt = m.winnerId === myId ? '🏆 You win!' : m.winnerName ? `${m.winnerName} wins!` : 'Round over';
        flashBanner(txt, 3500); setStatus(txt + (myId === hostId ? ' Press Space to play again.' : ''));
        log(m.winnerName ? `— ${m.winnerName} wins (length ${m.len}) —` : '— Round over —');
        break;
      }
      case 'log': log(m.msg); break;
      case 'chat': chatLine(m.id, m.msg); break;
    }
  };
}

// ---------- HUD ----------
// Chat stays out of the way while you're alive in a round: it shows for spectators, players who are
// out, and between rounds. Alive players can still open it with Enter.
function updateChat() {
  const inRound = roomState !== 'lobby', alive = state.snakes.some(s => s.id === myId);
  $('chatBox').classList.toggle('hidden', inRound && alive && document.activeElement !== $('chat'));
}
function setStatus(s) { $('status').textContent = s; }
function renderPlayers() {
  const lens = new Map(state.snakes.map(s => [s.id, s.body.length]));
  $('players').innerHTML = [...players].sort((a, b) => (lens.get(b.id) || 0) - (lens.get(a.id) || 0) || a.slot - b.slot).map(p => {
    const len = lens.get(p.id);
    const out = roomState !== 'lobby' && !len;
    return `<div class="${p.id === myId ? 'me' : ''}${out ? ' dead' : ''}"><span class="dot" style="background:${SNAKE_COLORS[p.slot]}"></span><span class="nm">${esc(p.name)}${p.id === hostId ? ' 👑' : ''}</span><span class="ln">${len || ''}${p.wins ? ` ${p.wins}★` : ''}</span></div>`;
  }).join('');
  $('startBtn').classList.toggle('hidden', !(myId === hostId && roomState === 'lobby'));
}
let lastLens = '';
function updateLengths() { const k = state.snakes.map(s => s.id + ':' + s.body.length).join(); if (k !== lastLens) { lastLens = k; renderPlayers(); } }
function addLine(d) { const l = $('log'), atBottom = l.scrollHeight - l.scrollTop - l.clientHeight < 30; l.appendChild(d); while (l.children.length > 100) l.firstChild.remove(); if (atBottom) l.scrollTop = l.scrollHeight; }
function log(msg) { const d = document.createElement('div'); d.className = 'ev'; d.textContent = msg; addLine(d); }
function chatLine(id, msg) { const d = document.createElement('div'); d.innerHTML = `<span class="who" style="color:${colorOf(id)}">${esc(nameOf(id))}</span>`; d.appendChild(document.createTextNode(msg)); addLine(d); }
function flashBanner(text, ms) { banner = { text, until: performance.now() + ms }; }

// ---------- drawing ----------
let view = { cs: 10, ox: 0, oy: 0 };
function fit() {
  const dpr = window.devicePixelRatio || 1, w = innerWidth, h = innerHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cs = Math.max(4, Math.floor(Math.min(w / GW, h / GH)));
  view = { cs, ox: Math.floor((w - cs * GW) / 2), oy: Math.floor((h - cs * GH) / 2), w, h };
}
const cx = c => view.ox + (c % GW) * view.cs, cy = c => view.oy + ((c / GW) | 0) * view.cs;
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }

function draw() {
  fit();
  const { cs, ox, oy, w, h } = view, now = performance.now();
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = theme.well; ctx.fillRect(ox, oy, cs * GW, cs * GH);
  // faint checkerboard so distances are readable on a big field
  ctx.fillStyle = theme.grid; ctx.globalAlpha = 0.35;
  for (let y = 0; y < GH; y++) for (let x = (y & 1); x < GW; x += 2) ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs);
  ctx.globalAlpha = 1;
  // dashed edge: snakes wrap around to the other side
  ctx.strokeStyle = '#3ccf6e'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.strokeRect(ox - 1, oy - 1, cs * GW + 2, cs * GH + 2); ctx.setLineDash([]);

  // food
  ctx.fillStyle = '#ff4d5e';
  for (const c of state.food) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, cs * 0.38, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#ffab4d';
  for (const c of state.drops) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, cs * 0.26, 0, 7); ctx.fill(); }
  // special foods pulse, and blink during their last 3 seconds
  for (const [c, type, left] of state.specials) {
    if (left < 3000 && Math.floor(now / 200) % 2) continue;
    const info = SPECIAL_INFO[type], r = cs * (0.55 + 0.1 * Math.sin(now / 150));
    ctx.fillStyle = info.color; ctx.shadowColor = info.color; ctx.shadowBlur = cs;
    ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#111'; ctx.font = `800 ${Math.round(cs * 0.75)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(info.icon, cx(c) + cs / 2, cy(c) + cs / 2 + 1);
  }
  // snakes
  for (const s of state.snakes) {
    const col = colorOf(s.id), mine = s.id === myId, fx = s.fx || {};
    ctx.globalAlpha = fx.ghost ? 0.45 : 1;
    if (fx.speed) { ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = cs * 0.8; }
    else if (fx.slow) { ctx.shadowColor = '#a0c4ff'; ctx.shadowBlur = cs * 0.8; }
    else if (fx.double) { ctx.shadowColor = '#7bffb0'; ctx.shadowBlur = cs * 0.6; }
    ctx.fillStyle = col;
    s.body.forEach((c, i) => { const pad = i === 0 ? 0 : Math.max(1, cs * 0.08); roundRect(cx(c) + pad, cy(c) + pad, cs - pad * 2, cs - pad * 2, cs * 0.3); });
    ctx.shadowBlur = 0;
    // eyes on the head, facing the direction of travel
    const hc = s.body[0], hx = cx(hc) + cs / 2, hy = cy(hc) + cs / 2;
    const [dx, dy] = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] }[s.dir];
    ctx.fillStyle = '#fff';
    for (const side of [-1, 1]) { const ex = hx + dx * cs * 0.15 + dy * side * cs * 0.22, ey = hy + dy * cs * 0.15 - dx * side * cs * 0.22; ctx.beginPath(); ctx.arc(ex, ey, cs * 0.13, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    // your own snake gets a ring around its head so it's easy to find on a crowded field
    if (mine) {
      ctx.strokeStyle = theme.text; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, cs * (now < countdownEnd ? 1.6 + 0.4 * Math.sin(now / 120) : 0.95), 0, 7); ctx.stroke();
      if (now < countdownEnd) { ctx.fillStyle = theme.text; ctx.font = `800 ${Math.max(12, cs)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('YOU', hx, hy - cs * 2); }
    }
  }
  // countdown / banners in the middle of the screen
  const left = countdownEnd - now;
  let big = null, color = '#ffcc33';
  if (left > 0) big = String(Math.ceil(left / 1000));
  else if (left > -600) { big = 'GO!'; color = '#4cde6c'; }
  else if (banner && banner.until > now) big = banner.text;
  if (big) {
    ctx.save(); ctx.font = `900 ${Math.round(Math.min(w, h) * (big.length > 3 ? 0.08 : 0.2))}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.strokeText(big, w / 2, h / 2);
    ctx.fillStyle = color; ctx.fillText(big, w / 2, h / 2); ctx.restore();
  }
  requestAnimationFrame(draw);
}

// ---------- input ----------
document.addEventListener('keydown', e => {
  if (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === 'Enter') { $('chatBox').classList.remove('hidden'); $('chat').focus(); e.preventDefault(); return; }
  if (e.key === ' ') { if (myId === hostId && roomState === 'lobby') net({ t: 'start' }); e.preventDefault(); return; }
  const d = KEYS[e.key];
  if (d) { net({ t: 'dir', d }); e.preventDefault(); }
});
$('chat').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { if (e.target.value.trim()) net({ t: 'chat', msg: e.target.value }); e.target.value = ''; e.target.blur(); }
  else if (e.key === 'Escape') e.target.blur();
});
$('chat').addEventListener('blur', updateChat);
$('startBtn').onclick = e => { net({ t: 'start' }); e.target.blur(); };
$('theme').value = document.documentElement.dataset.theme || 'system';
$('theme').addEventListener('change', e => { document.documentElement.dataset.theme = e.target.value; try { localStorage.setItem('sw-theme', e.target.value); } catch {} readTheme(); e.target.blur(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);
$('specialList').innerHTML = Object.values(SPECIAL_INFO).map(s => `<li><span class="ic" style="background:${s.color}">${s.icon}</span><b>${s.name}</b> ${s.desc}</li>`).join('');

readTheme(); connect(); requestAnimationFrame(draw);
})();
