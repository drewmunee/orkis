// Snakewar client: draws the server's field and sends steering input.
(() => {
const $ = id => document.getElementById(id);
const SNAKE_COLORS = ['', '#ff5470', '#30d5ff', '#4cde6c', '#ffd23f', '#b45cff', '#ff9a3c', '#3d7bff', '#ff66d9', '#7bffb0', '#c8a2ff', '#ffb347', '#a0e8ff'];
// Team matches: every snake gets its own shade, but reds stay warm (red/orange/yellow/pink) and blues
// stay cool (blue/green/purple/cyan), so teams are obvious and teammates still tell apart.
const TEAM_SHADES = {
  red: ['#ff3b3b', '#ff9a1f', '#ffd400', '#ff5fa8', '#b3122e', '#ffb38a'],
  blue: ['#2f6bff', '#1fbf5a', '#9b5cff', '#19c8e6', '#0f8f8a', '#8fb4ff'],
};
const TEAM_COLOR = { red: '#ff2d2d', blue: '#2f6bff' };
const SPECIAL_INFO = {
  speed: { name: 'Speed', icon: '⚡', color: '#ffd23f', desc: 'move twice as fast for 5 seconds (also clears Slow)' },
  ghost: { name: 'Ghost', icon: '👻', color: '#cfd8ff', desc: 'held item: press Space to slide through snakes for 6 seconds' },
  feast: { name: 'Feast', icon: '+5', color: '#ff66d9', desc: 'grow 5 segments at once' },
  shears: { name: 'Shears', icon: '✂', color: '#ff7b7b', desc: 'enemy snakes lose a quarter of their length; the cut tails become tiny food' },
  double: { name: 'Double', icon: 'x2', color: '#7bffb0', desc: 'all growth counts double for 20 seconds' },
  slow: { name: 'Slow', icon: '🐌', color: '#a0c4ff', desc: 'enemies move at half speed for 5 seconds (a sped-up enemy just loses its Speed)' },
  extendo: { name: 'Extendo', icon: '👅', color: '#ff8fb1', desc: 'an 8-second tongue reaching 3 squares ahead; enemies who touch it die' },
  blockade: { name: 'Blockade', icon: '▦', color: '#aab0c4', desc: 'held item: press Space to drop 5 tail segments as a permanent wall' },
  token: { name: 'Revive token', icon: '♥', color: '#ff4d6d', desc: 'team mode only: every 3 your team collects earns a revive' },
};
const KEYS = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', w: 'U', s: 'D', a: 'L', d: 'R', W: 'U', S: 'D', A: 'L', D: 'R' };
const ITEM_SLOTS = 3;
// screen space kept free around the field for the side panels and the top bar
const PAD = { left: 252, right: 156, top: 52, bottom: 10 };

let name = '';
try { name = localStorage.getItem('sw-name') || ''; } catch {}
const room = new URLSearchParams(location.search).get('room') || 'lobby';
if (!name.trim()) { location.replace('/'); return; }

let ws, myId = null, hostId = null, roomState = 'lobby', teamMode = false, GW = 112, GH = 63;
let players = [], state = { snakes: [], food: [], drops: [], bits: [], walls: [], specials: [] };
let countdownEnd = 0, banner = null, best = null; // banner: {text, until}; best: classic high score once known

const canvas = $('field'), ctx = canvas.getContext('2d');
let theme = {};
function readTheme() { const cs = getComputedStyle(document.documentElement); theme = { well: cs.getPropertyValue('--well').trim(), grid: cs.getPropertyValue('--grid').trim(), bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() }; }

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const playerOf = id => players.find(q => q.id === id);
function colorOf(id) {
  const p = playerOf(id);
  if (!p) return '#888';
  if (p.team) { const mates = players.filter(q => q.team === p.team).sort((a, b) => a.slot - b.slot); return TEAM_SHADES[p.team][mates.indexOf(p) % 6]; }
  return SNAKE_COLORS[p.slot];
}
const nameOf = id => (playerOf(id) || {}).name || '?';
const myTeam = () => (playerOf(myId) || {}).team;

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
      case 'lobby':
        if (!!m.teamMode !== teamMode && m.state === 'lobby') setStatus(''); // mode switched: last result no longer applies
        players = m.players; hostId = m.hostId; roomState = m.state; teamMode = !!m.teamMode; renderPlayers(); updateChat(); break;
      case 'start':
        players = m.players; countdownEnd = performance.now() + m.countdown; banner = null;
        setStatus(players.length === 1 ? 'Classic snake: walls are solid. Eat as much as you can!' : m.teamMatch ? `You're on team ${myTeam() === 'red' ? 'Red' : 'Blue'}!` : '');
        log('— Round started —'); renderPlayers();
        break;
      case 'state': state = m; if (m.w) { GW = m.w; GH = m.h; } renderScore(); updateLengths(); updateChat(); renderItems(); renderTeams(); break;
      case 'ate': if (m.id === myId) { const i = SPECIAL_INFO[m.special]; flashBanner(i.name + (m.special === 'ghost' || m.special === 'blockade' ? ' (saved)' : '!'), 900); } break;
      case 'used': if (m.id === myId) flashBanner(SPECIAL_INFO[m.item].name + '!', 700); break;
      case 'note': flashBanner(m.msg, 1200); break;
      case 'gameover': {
        if (state.classic) break; // solo score arrives in its own 'classic' message
        let txt;
        if ('winnerTeam' in m) txt = !m.winnerTeam ? 'Round over' : (m.winnerTeam === myTeam() ? '🏆 ' : '') + `${m.winnerTeam === 'red' ? 'Red' : 'Blue'} team wins!`;
        else txt = m.winnerId === myId ? '🏆 You win!' : m.winnerName ? `${m.winnerName} wins!` : 'Round over';
        flashBanner(txt, 3500); setStatus(txt + (myId === hostId ? ' Press Space to play again.' : ''));
        log(m.winnerName ? `— ${m.winnerName} wins (length ${m.len}) —` : `— ${txt.replace('🏆 ', '')} —`);
        break;
      }
      case 'classic': {
        if (m.best != null) best = m.best;
        const txt = m.error ? `Score ${m.score} (couldn't save)` : !m.score ? 'Score 0' : m.score >= m.best ? `Score ${m.score}: new high score!` : `Score ${m.score} · best ${m.best}`;
        flashBanner(txt, 4000); setStatus(txt + ' Press Space to play again.'); log(txt); renderScore();
        break;
      }
      case 'log': log(m.msg); break;
      case 'chat': chatLine(m.id, m.msg); break;
    }
  };
}

// ---------- side panels ----------
// Chat stays out of the way while you're alive in a round: it shows for spectators, players who are
// out, and between rounds. Alive players can still open it with Enter.
function updateChat() {
  const inRound = roomState !== 'lobby', alive = state.snakes.some(s => s.id === myId);
  const box = $('chatBox'), wasHidden = box.classList.contains('hidden');
  box.classList.toggle('hidden', inRound && alive && document.activeElement !== $('chat'));
  if (wasHidden && !box.classList.contains('hidden') && chatPinned) $('log').scrollTop = $('log').scrollHeight;
}
function renderScore() { // classic solo: show food eaten and the best so far
  const me = state.snakes.find(s => s.id === myId);
  $('score').classList.toggle('hidden', !state.classic);
  if (state.classic) $('score').textContent = `Score ${me ? me.eaten : 0}` + (best != null ? ` · Best ${best}` : '');
}
function setStatus(s) { $('status').textContent = s; }
function renderPlayers() {
  const lens = new Map(state.snakes.map(s => [s.id, s.body.length]));
  $('players').innerHTML = [...players].sort((a, b) => (a.team || '').localeCompare(b.team || '') || (lens.get(b.id) || 0) - (lens.get(a.id) || 0) || a.slot - b.slot).map(p => {
    const len = lens.get(p.id);
    const out = roomState !== 'lobby' && !len;
    const tag = p.team ? `<span class="tm" style="background:${TEAM_COLOR[p.team]}">${p.team === 'red' ? 'R' : 'B'}</span>` : '';
    return `<div class="${p.id === myId ? 'me' : ''}${out ? ' dead' : ''}"><span class="dot" style="background:${colorOf(p.id)}"></span>${tag}<span class="nm">${esc(p.name)}${p.id === hostId ? ' 👑' : ''}</span><span class="ln">${len || ''}${p.wins ? ` ${p.wins}★` : ''}</span></div>`;
  }).join('');
  const hostInLobby = myId === hostId && roomState === 'lobby', teamReady = teamMode && players.length >= 2;
  $('startBtn').classList.toggle('hidden', !hostInLobby);
  $('startBtn').textContent = players.length === 1 ? 'Start solo (classic)' : teamReady ? 'Start team round' : 'Start round';
  $('teamBtn').classList.toggle('hidden', !hostInLobby);
  $('teamBtn').textContent = teamMode ? 'Team mode: ON (switch to free-for-all)' : 'Switch to team mode';
  $('teamBtn').classList.toggle('on', teamMode);
  $('modeInfo').textContent = roomState !== 'lobby' ? '' : teamReady ? 'Next round: Red vs Blue (teams picked at random)'
    : teamMode ? 'Team mode needs 2+ players; starting now is classic solo' : '';
}
let lastLens = '';
function updateLengths() { const k = state.snakes.map(s => s.id + ':' + s.body.length).join(); if (k !== lastLens) { lastLens = k; renderPlayers(); } }
// The log sticks to the newest line unless you've scrolled up to read older ones.
let chatPinned = true;
$('log').addEventListener('scroll', () => { const l = $('log'); if (l.clientHeight) chatPinned = l.scrollHeight - l.scrollTop - l.clientHeight < 30; });
function addLine(d) { const l = $('log'); l.appendChild(d); while (l.children.length > 150) l.firstChild.remove(); if (chatPinned) l.scrollTop = l.scrollHeight; }
function log(msg) { const d = document.createElement('div'); d.className = 'ev'; d.textContent = msg; addLine(d); }
function chatLine(id, msg) { const d = document.createElement('div'); d.innerHTML = `<span class="who" style="color:${colorOf(id)}">${esc(nameOf(id))}</span>`; d.appendChild(document.createTextNode(msg)); addLine(d); }
function flashBanner(text, ms) { banner = { text, until: performance.now() + ms }; }

// Held items: big icons down the right side, readable from the corner of your eye
let lastItems = '';
function renderItems() {
  const me = state.snakes.find(s => s.id === myId), items = me ? me.items || [] : [];
  const key = items.join() + (me ? '' : '-');
  if (key === lastItems) return; lastItems = key;
  let html = '';
  for (let i = 0; i < ITEM_SLOTS; i++) {
    const it = items[i], info = it && SPECIAL_INFO[it];
    html += info ? `<div class="item${i === 0 ? ' next' : ''}" style="--c:${info.color}"><span class="ic">${info.icon}</span><span class="lb">${i === 0 ? 'SPACE' : info.name}</span></div>`
      : '<div class="item empty"></div>';
  }
  $('items').innerHTML = html;
}
// Team matches: revive counts at the top, your team's token progress under the scoreboard
function renderTeams() {
  const t = state.teams;
  $('teamRevives').classList.toggle('hidden', !t);
  $('tokens').classList.toggle('hidden', !t || !myTeam());
  if (!t) return;
  $('teamRevives').innerHTML = `<span class="red">RED ♥ ${t.red.revives}</span><span class="blue">BLUE ♥ ${t.blue.revives}</span>`;
  const mine = t[myTeam()];
  if (mine) $('tokens').innerHTML = `Revive tokens <span class="pips">${'♥'.repeat(mine.tokens)}<span class="off">${'♥'.repeat(3 - mine.tokens)}</span></span><small>3 tokens = 1 team revive</small>`;
}

// ---------- drawing ----------
let view = { cs: 10, ox: 0, oy: 0 };
function fit() {
  const dpr = window.devicePixelRatio || 1, w = innerWidth, h = innerHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the field gets whatever space the side panels and top bar leave
  const aw = w - PAD.left - PAD.right, ah = h - PAD.top - PAD.bottom;
  const cs = Math.max(4, Math.floor(Math.min(aw / GW, ah / GH)));
  view = { cs, ox: PAD.left + Math.floor((aw - cs * GW) / 2), oy: PAD.top + Math.floor((ah - cs * GH) / 2), w, h };
}
const cx = c => view.ox + (c % GW) * view.cs, cy = c => view.oy + ((c / GW) | 0) * view.cs;
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
const rectOf = b => [view.ox + b.x0 * view.cs, view.oy + b.y0 * view.cs, (b.x1 - b.x0) * view.cs, (b.y1 - b.y0) * view.cs];

function draw() {
  fit();
  const { cs, ox, oy, w, h } = view, now = performance.now();
  const b = state.bounds || { x0: 0, y0: 0, x1: GW, y1: GH };
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, w, h);
  // area the board has already shrunk away from: dark and hatched
  ctx.fillStyle = theme.well; ctx.fillRect(ox, oy, cs * GW, cs * GH);
  ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(ox, oy, cs * GW, cs * GH);
  const [bx, by, bw, bh] = rectOf(b);
  ctx.fillStyle = theme.well; ctx.fillRect(bx, by, bw, bh);
  // faint checkerboard so distances are readable on a big field
  ctx.fillStyle = theme.grid; ctx.globalAlpha = 0.35;
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0 + ((y + b.x0) & 1); x < b.x1; x += 2) ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs);
  ctx.globalAlpha = 1;
  // dashed edge: snakes wrap around to the other side; solid in classic solo, where walls kill
  ctx.strokeStyle = '#3ccf6e'; ctx.lineWidth = state.classic ? 4 : 2; ctx.setLineDash(state.classic ? [] : [8, 6]); ctx.strokeRect(bx - 1, by - 1, bw + 2, bh + 2); ctx.setLineDash([]);
  // upcoming shrink: the new edge, in red
  if (state.shrink) {
    const [sx, sy, sw, sh] = rectOf(state.shrink.bounds);
    ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 3; ctx.setLineDash([10, 6]); ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now / 120);
    ctx.strokeRect(sx, sy, sw, sh); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  // blockades
  for (const c of state.walls || []) {
    ctx.fillStyle = '#5b6178'; ctx.fillRect(cx(c), cy(c), cs, cs);
    ctx.strokeStyle = '#2b2f40'; ctx.lineWidth = Math.max(1, cs * 0.12); ctx.strokeRect(cx(c) + 1, cy(c) + 1, cs - 2, cs - 2);
  }
  // food: regular (red), dropped by dead snakes (orange), tiny (yellow dots)
  ctx.fillStyle = '#ff4d5e';
  for (const c of state.food) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, cs * 0.38, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#ffab4d';
  for (const c of state.drops) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, cs * 0.26, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#ffd84d';
  for (const c of state.bits || []) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, Math.max(1.5, cs * 0.14), 0, 7); ctx.fill(); }
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
    const col = colorOf(s.id), mine = s.id === myId, fx = s.fx || {}, team = (playerOf(s.id) || {}).team;
    const hc = s.body[0], hx = cx(hc) + cs / 2, hy = cy(hc) + cs / 2;
    const [dx, dy] = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] }[s.dir];
    // Extendo tongue
    if (s.tongue && s.tongue.length) {
      ctx.strokeStyle = '#ff5c8a'; ctx.lineWidth = Math.max(2, cs * 0.28); ctx.lineCap = 'round';
      const last = s.tongue[s.tongue.length - 1], tx = cx(last) + cs / 2, ty = cy(last) + cs / 2;
      const wraps = Math.abs(tx - hx) > cs * 4 || Math.abs(ty - hy) > cs * 4;
      ctx.beginPath(); ctx.moveTo(hx, hy);
      if (!wraps) ctx.lineTo(tx, ty); else for (const c of s.tongue) ctx.lineTo(cx(c) + cs / 2, cy(c) + cs / 2);
      ctx.stroke();
      if (!wraps) { // forked tip
        const fx1 = tx + dx * cs * 0.4, fy1 = ty + dy * cs * 0.4;
        ctx.lineWidth = Math.max(1.5, cs * 0.16); ctx.beginPath();
        ctx.moveTo(tx, ty); ctx.lineTo(fx1 + dy * cs * 0.3, fy1 - dx * cs * 0.3);
        ctx.moveTo(tx, ty); ctx.lineTo(fx1 - dy * cs * 0.3, fy1 + dx * cs * 0.3); ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    ctx.globalAlpha = fx.ghost ? 0.45 : 1;
    if (fx.speed) { ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = cs * 0.8; }
    else if (fx.slow) { ctx.shadowColor = '#a0c4ff'; ctx.shadowBlur = cs * 0.8; }
    else if (fx.double) { ctx.shadowColor = '#7bffb0'; ctx.shadowBlur = cs * 0.6; }
    ctx.fillStyle = col;
    s.body.forEach((c, i) => { const pad = i === 0 ? 0 : Math.max(1, cs * 0.08); roundRect(cx(c) + pad, cy(c) + pad, cs - pad * 2, cs - pad * 2, cs * 0.3); });
    ctx.shadowBlur = 0;
    // team matches: the head carries a ring in the pure team color
    if (team) { ctx.strokeStyle = TEAM_COLOR[team]; ctx.lineWidth = Math.max(2, cs * 0.14); ctx.beginPath(); ctx.roundRect(cx(hc) - 1, cy(hc) - 1, cs + 2, cs + 2, cs * 0.35); ctx.stroke(); }
    // eyes on the head, facing the direction of travel
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
  // shrink warning in the top bar
  $('shrinkMsg').classList.toggle('hidden', !state.shrink);
  if (state.shrink) $('shrinkMsg').textContent = `⚠ Board shrinks in ${Math.max(0, Math.ceil(state.shrink.left / 1000))}`;
  // countdown / banners in the middle of the field
  const left = countdownEnd - now, mx = ox + cs * GW / 2, my = oy + cs * GH / 2;
  let big = null, color = '#ffcc33';
  if (left > 0) big = String(Math.ceil(left / 1000));
  else if (left > -600) { big = 'GO!'; color = '#4cde6c'; }
  else if (banner && banner.until > now) big = banner.text;
  if (big) {
    ctx.save(); ctx.font = `900 ${Math.round(Math.min(cs * GW, cs * GH) * (big.length > 3 ? 0.09 : 0.22))}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.strokeText(big, mx, my);
    ctx.fillStyle = color; ctx.fillText(big, mx, my); ctx.restore();
  }
  requestAnimationFrame(draw);
}

// ---------- input ----------
document.addEventListener('keydown', e => {
  if (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === 'Enter') { $('chatBox').classList.remove('hidden'); $('chat').focus(); updateChat(); e.preventDefault(); return; }
  if (e.key === ' ') {
    // Space: host starts a round between rounds; during a round it uses your next held item
    if (roomState === 'lobby') { if (myId === hostId) net({ t: 'start' }); }
    else net({ t: 'use' });
    e.preventDefault(); return;
  }
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
$('teamBtn').onclick = e => { net({ t: 'teammode', on: !teamMode }); e.target.blur(); };
// Back to the homepage. Leaving while still alive in a round means dying, so ask first.
$('leaveBtn').onclick = e => {
  const alive = roomState !== 'lobby' && state.snakes.some(s => s.id === myId);
  if (alive && !confirm('Leave this round? Your snake will be out.')) { e.target.blur(); return; }
  location.href = '/';
};
$('theme').value = document.documentElement.dataset.theme || 'system';
$('theme').addEventListener('change', e => { document.documentElement.dataset.theme = e.target.value; try { localStorage.setItem('sw-theme', e.target.value); } catch {} readTheme(); e.target.blur(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);
$('specialList').innerHTML = Object.values(SPECIAL_INFO).map(s => `<li><span class="ic" style="background:${s.color}">${s.icon}</span><span><b>${s.name}</b> – ${s.desc}</span></li>`).join('');

readTheme(); renderItems(); connect(); requestAnimationFrame(draw);
})();
