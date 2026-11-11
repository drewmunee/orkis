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
  ghost: { name: 'Ghost', icon: '👻', color: '#cfd8ff', desc: 'held item: press Space for 6 seconds of sliding through snakes and blockades, immune to other players\' items (Shears, Slow, Bomb, Extendo)' },
  feast: { name: 'Feast', icon: '+5', color: '#ff66d9', desc: 'grow by the number shown: +5 plus 5 for every minute the round has run, and it grows by 1 every 3 seconds until someone eats it (never vanishes)' },
  shears: { name: 'Shears', icon: '✂', color: '#ff7b7b', desc: 'enemy snakes lose a quarter of their length; the cut tails become tiny food' },
  double: { name: 'Double', icon: 'x2', color: '#7bffb0', desc: 'all growth counts double for 20 seconds' },
  slow: { name: 'Slow', icon: '🐌', color: '#a0c4ff', desc: 'enemies move at half speed for 5 seconds (a sped-up enemy just loses its Speed)' },
  extendo: { name: 'Extendo', icon: '👅', color: '#ff8fb1', desc: 'a 12-second tongue reaching 5 squares ahead: enemies who run into it die, and it eats any food it touches' },
  blockade: { name: 'Blockade', icon: '▦', color: '#aab0c4', desc: 'held item: press Space to drop 5 tail segments as a wall (max 5 on the board; ghosts pass through)' },
  bomb: { name: 'Bomb', icon: '💣', color: '#ff6a3d', desc: 'held item: press Space to drop it out of your tail; after 3 s it destroys everything in its radius and every snake touching the blast loses a quarter of its length (you too!)' },
  pacman: { name: 'Pacman', icon: 'ᗧ', color: '#ffe14d', desc: 'held item: press Space for 6 seconds of sliding through enemy snakes and eating them: every square of a snake you pass through costs them 1 length and gives you 1. Heads and ghosts can\'t be bitten' },
  poop: { name: 'Poop', icon: '💩', color: '#b07a45', desc: 'held item: press Space to leave a slimy trail for 6 seconds; enemies who cross it are slowed (the slime lasts 8 s)' },
  stone: { name: 'Stone', icon: '🪨', color: '#a3a3a3', desc: 'held item: press Space to turn to stone for 5 seconds: you stop moving and nothing can hurt you except the shrinking board, and any snake that runs into you dies (ghosts and Pacman too)' },
  token: { name: 'Revive token', icon: '♥', color: '#ff4d6d', desc: 'team mode only: every 3 your team collects earns a revive' },
};
// item icon as HTML: Pacman is drawn with CSS (no font has a dependable Pacman character)
const iconHtml = (type, info) => type === 'pacman' ? '<span class="pacman"></span>' : info.icon;
// steering keys for each control scheme (⚙ Settings); before a player picks one, both work
const ARROW_KEYS = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };
const WASD_KEYS = { w: 'U', s: 'D', a: 'L', d: 'R' };
const steerKey = key => {
  const c = SW.controls(), k = key.length === 1 ? key.toLowerCase() : key;
  return (c !== 'wasd' && ARROW_KEYS[k]) || (c !== 'arrows' && WASD_KEYS[k]) || null;
};
const renderKeysHelp = () => { $('keysHelp').innerHTML = `<b>${{ wasd: 'WASD', arrows: 'Arrow keys' }[SW.controls()] || 'Arrows / WASD'}</b> steer${{ nokia: ' (or <b>NOKIA</b>: numpad 1 / 9)', vim: ' (or <b>VIM</b>: H / L)' }[SW.snakeKeys()] || ''} · <b>Space</b> use your next held item (host: start round) · <b>T</b> chat · change keys in ⚙ Settings`; };
const ITEM_SLOTS = 3;
// screen space kept free around the field for the side panels and the top bar
const PAD = { left: 252, right: 156, top: 52, bottom: 10 };

let name = '';
try { name = localStorage.getItem('sw-name') || ''; } catch {}
const room = new URLSearchParams(location.search).get('room') || 'lobby';
if (!name.trim()) { location.replace('/'); return; }

let ws, myId = null, hostId = null, roomState = 'lobby', teamMode = false, teamChoice = 'random', tileMode = 'fruit', GW = 112, GH = 63;
// bonus tiles (host's choice): fruit (3 of a kind = bonus), letters (4 that spell a word) or none
const FRUIT_ICON = { banana: '🍌', cherry: '🍒', orange: '🍊' };
const TILE_LABEL = { fruit: '🍌 Fruit', letters: '🔤 Letters', none: 'None' };
const FRUIT_DOES = { banana: 'grow', cherry: 'cut', orange: '2 items' }; // what 3 of each fruit does
let players = [], state = { snakes: [], food: [], drops: [], bits: [], walls: [], specials: [] };
let booms = []; // recent explosions, for a quick flash
let countdownEnd = 0, banner = null, best = null; // banner: {text, until}; best: classic high score once known

const canvas = $('field'), ctx = canvas.getContext('2d');
let theme = {};
function readTheme() { const cs = getComputedStyle(document.documentElement); theme = { well: cs.getPropertyValue('--well').trim(), grid: cs.getPropertyValue('--grid').trim(), bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() }; }

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const playerOf = id => players.find(q => q.id === id);
function colorOf(id) {
  const p = playerOf(id);
  if (!p) return '#888888';
  if (p.team) { const mates = players.filter(q => q.team === p.team).sort((a, b) => a.slot - b.slot); return TEAM_SHADES[p.team][(p.shade ?? mates.indexOf(p)) % 6]; }
  if (teamMode && roomState === 'lobby' && teamChoice === 'choose' && p.teamPick) return TEAM_SHADES[p.teamPick][(p.shade ?? 0) % 6]; // the team they picked for next round
  return SNAKE_COLORS[p.color || p.slot];
}
const nameOf = id => (playerOf(id) || {}).name || '?';
const myTeam = () => (playerOf(myId) || {}).team;

// ---------- network ----------
function net(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => net({ t: 'join', game: 'snake', name, room, bid: SW.bid, avatar: SW.avatar(), shade: SW.teamShade() });
  ws.onclose = () => setStatus('Disconnected. Reload to rejoin.');
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'error': setStatus(m.msg); break;
      case 'welcome': myId = m.id; GW = m.w; GH = m.h; $('roomName').textContent = m.room; break;
      case 'lobby':
        if (!!m.teamMode !== teamMode && m.state === 'lobby') setStatus(''); // mode switched: last result no longer applies
        players = m.players; hostId = m.hostId; roomState = m.state; teamMode = !!m.teamMode; teamChoice = m.teamChoice || 'random'; tileMode = m.tileMode || 'fruit'; renderPlayers(); updateChat(); break;
      case 'start':
        players = m.players; countdownEnd = performance.now() + m.countdown; banner = null;
        setStatus((playerOf(myId) || {}).spectating ? 'You\'re spectating this round (type /spectate to play).'
          : players.filter(p => !p.spectating).length === 1 ? 'Classic snake: walls are solid. Eat as much as you can!' : m.teamMatch ? `You're on team ${myTeam() === 'red' ? 'Red' : 'Blue'}!` : '');
        log('— Round started —'); renderPlayers();
        break;
      case 'state': state = m; if (m.w) { GW = m.w; GH = m.h; } renderScore(); updateLengths(); updateChat(); renderItems(); renderLetters(); renderTeams(); break;
      case 'ate': if (m.id === myId) { const i = SPECIAL_INFO[m.special]; flashBanner(i.name + (['ghost', 'blockade', 'bomb', 'pacman', 'poop', 'stone'].includes(m.special) ? ' (saved)' : '!'), 900); } break;
      case 'used': if (m.id === myId) flashBanner(SPECIAL_INFO[m.item].name + '!', 700); break;
      case 'note': flashBanner(m.msg, 1200); break;
      case 'word': if (m.id === myId) flashBanner(`${FRUIT_ICON[m.word] ? FRUIT_ICON[m.word].repeat(3) : m.word}! ${m.reward === 'grow' ? 'Grow!' : m.reward === 'items' ? (m.items || []).map(i => SPECIAL_INFO[i] ? SPECIAL_INFO[i].name : i).join(' + ') : 'Cut them!'}`, 1800); break;
      case 'boom': booms = booms.filter(b => performance.now() - b.t < 500).concat({ cell: m.cell, r: m.r, t: performance.now() }); break;
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
        const board = m.score ? SW.leaderboardText(m, 'food') : '';
        const txt = `Score ${m.score}` + (m.score && !m.error && !m.onBoard && m.best > m.prevBest ? ': new personal best!' : '');
        flashBanner(m.score && m.onBoard && m.best > m.prevBest ? `🏅 #${m.rank} on the leaderboard!` : txt, 4000);
        setStatus(txt + (board ? '. ' + board : '') + '. Press Space to play again.'); log(txt + (board ? '. ' + board : '')); renderScore();
        break;
      }
      case 'log': log(m.msg); break;
      case 'chat': chatLine(m.id, m.msg); break;
    }
  };
}

// ---------- side panels ----------
// Chat stays out of the way while you're alive in a round: it shows for spectators, players who are
// out, and between rounds. Alive players can still open it with T.
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
const canPickColor = () => roomState === 'lobby' || !state.snakes.some(s => s.id === myId);
function renderPlayers() {
  const lens = new Map(state.snakes.map(s => [s.id, s.body.length]));
  $('players').innerHTML = [...players].sort((a, b) => (a.team || '').localeCompare(b.team || '') || (lens.get(b.id) || 0) - (lens.get(a.id) || 0) || a.slot - b.slot).map(p => {
    const len = lens.get(p.id);
    const out = roomState !== 'lobby' && !len;
    const tm = p.team || (teamMode && roomState === 'lobby' && teamChoice === 'choose' ? p.teamPick : null); // in the lobby: the team they've picked
    const tag = tm ? `<span class="tm" style="background:${TEAM_COLOR[tm]}" title="${tm === 'red' ? 'Red' : 'Blue'} team">${tm === 'red' ? 'R' : 'B'}</span>` : '';
    // your own row gets ‹ › to change color whenever you're not in play
    const pick = p.id === myId && canPickColor();
    const dot = `<span class="dot" style="background:${colorOf(p.id)}"></span>`;
    return `<div class="${p.id === myId ? 'me' : ''}${out ? ' dead' : ''}">${pick ? '<button class="cbtn" data-d="-1" title="Previous color">‹</button>' + dot + '<button class="cbtn" data-d="1" title="Next color">›</button>' : dot}${tag}<span class="nm" title="${esc(p.name)}">${p.bot ? '<span class="botTag" title="Bot">🤖</span>' : SW.avatarHtml(p)}${esc(p.name)}${p.id === hostId ? ' 👑' : ''}${p.bot && myId === hostId && roomState === 'lobby' ? ` <button class="rmBot" data-id="${p.id}" title="Remove this bot">×</button>` : ''}${p.spectating ? ' <span class="spec" title="Spectating (not playing)">👁</span>' : ''}</span><span class="ln">${len || ''}${p.wins ? ` ${p.wins}★` : ''}</span></div>`;
  }).join('');
  // host, between rounds: ＋ adds a bot (up to the 12-player limit); × removes one
  if (myId === hostId && roomState === 'lobby' && players.length < 12) $('players').insertAdjacentHTML('beforeend', '<button id="addBot" type="button" title="Add a computer-controlled snake">＋ Add bot</button>');
  const add = $('addBot'); if (add) add.onclick = e => { net({ t: 'addbot' }); e.currentTarget.blur(); };
  for (const b of $('players').querySelectorAll('.rmBot')) b.onclick = e => { net({ t: 'removebot', id: +b.dataset.id }); e.currentTarget.blur(); };
  for (const b of $('players').querySelectorAll('.cbtn')) b.onclick = e => { net({ t: 'color', d: +b.dataset.d }); e.currentTarget.blur(); };
  const hostInLobby = myId === hostId && roomState === 'lobby', teamReady = teamMode && players.length >= 2;
  $('startBtn').classList.toggle('hidden', !hostInLobby);
  $('startBtn').textContent = players.length === 1 ? 'Start solo (classic)' : teamReady ? 'Start team round' : 'Start round';
  $('teamBtn').classList.toggle('hidden', !hostInLobby);
  $('teamBtn').textContent = teamMode ? 'Team mode: ON (switch to free-for-all)' : 'Switch to team mode';
  $('teamBtn').classList.toggle('on', teamMode);
  $('tilesBtn').classList.toggle('hidden', !hostInLobby);
  $('tilesBtn').textContent = `Bonus tiles: ${TILE_LABEL[tileMode]} (change)`;
  const tilesTxt = roomState !== 'lobby' || players.filter(p => !p.spectating).length < 2 ? '' : `Bonus tiles: ${TILE_LABEL[tileMode]}`;
  $('teamChoiceBtn').classList.toggle('hidden', !hostInLobby || !teamMode);
  $('teamChoiceBtn').textContent = teamChoice === 'choose' ? 'Teams: players choose (switch to random)' : 'Teams: random (switch to players choose)';
  $('modeInfo').textContent = roomState !== 'lobby' ? '' : [teamReady ? (teamChoice === 'choose' ? 'Next round: Red vs Blue. Pick your team with ‹ › by your name (no pick = filled in to balance)' : 'Next round: Red vs Blue, random teams')
    : teamMode ? 'Team mode needs 2+ players; starting now is classic solo' : '', tilesTxt].filter(Boolean).join(' · ');
}
let lastLens = '';
function updateLengths() { const k = state.snakes.map(s => s.id + ':' + s.body.length).join(); if (k !== lastLens) { lastLens = k; renderPlayers(); } }
// The log sticks to the newest line unless you've scrolled up to read older ones.
let chatPinned = true;
$('log').addEventListener('scroll', () => { const l = $('log'); if (l.clientHeight) chatPinned = l.scrollHeight - l.scrollTop - l.clientHeight < 30; });
function addLine(d) { const l = $('log'); l.appendChild(d); while (l.children.length > 150) l.firstChild.remove(); if (chatPinned) l.scrollTop = l.scrollHeight; }
function log(msg) { const d = document.createElement('div'); d.className = 'ev'; d.textContent = msg; addLine(d); }
function chatLine(id, msg) { const d = document.createElement('div'); d.innerHTML = `<span class="who" style="color:${colorOf(id)}">${SW.avatarHtml(playerOf(id))}${esc(nameOf(id))}</span>`; d.appendChild(document.createTextNode(msg)); addLine(d); }
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
    html += info ? `<div class="item${i === 0 ? ' next' : ''}" style="--c:${info.color}"><span class="ic">${iconHtml(it, info)}</span><span class="lb">${i === 0 ? 'SPACE' : info.name}</span></div>`
      : '<div class="item empty"></div>';
  }
  $('items').innerHTML = html;
}
// Letter rack: the letters you've collected (4 that make a word pay out), under the items
let lastLetters = '';
function renderLetters() {
  const me = state.snakes.find(s => s.id === myId), ls = me ? me.letters || [] : [], fr = (me && me.fruit) || {};
  const mode = state.tileMode || 'fruit', show = !state.classic && roomState !== 'lobby' && mode !== 'none';
  const key = (show ? mode : '-') + ls.join('') + JSON.stringify(fr);
  if (key === lastLetters) return; lastLetters = key;
  $('lettersWrap').classList.toggle('hidden', !show);
  let html = '';
  if (mode === 'fruit') { // each fruit with its count toward 3, and what 3 of it does
    for (const f of Object.keys(FRUIT_ICON)) html += `<div class="fruitRow" title="3 ${f === 'cherry' ? 'cherries' : f + 's'}: ${FRUIT_DOES[f]}"><span class="fi">${FRUIT_ICON[f]}</span>${[0, 1, 2].map(i => `<span class="pip${i < (fr[f] || 0) ? ' on' : ''}"></span>`).join('')}<span class="fd">${FRUIT_DOES[f]}</span></div>`;
    $('rackLabel').textContent = 'Fruit'; $('rackHint').textContent = 'collect 3 of a kind';
  } else {
    for (let i = 0; i < 4; i++) html += ls[i] ? `<span class="tile">${ls[i]}</span>` : '<span class="tile empty"></span>';
    $('rackLabel').textContent = 'Letters'; $('rackHint').textContent = '4 that spell a word = bonus';
  }

  $('rack').className = mode === 'fruit' ? 'fruit' : '';
  $('rack').innerHTML = html;
}
// Team matches: revive counts at the top, your team's token progress under the scoreboard
// Team rounds: each team's banked revives with its revive-token progress (3 = 1 revive) beside it, for everyone
function renderTeams() {
  const t = state.teams;
  $('teamRevives').classList.toggle('hidden', !t);
  if (!t) return;
  const pips = n => `<small class="pips" title="Revive tokens: ${n}/3 toward the next revive">${'●'.repeat(n)}<span class="off">${'●'.repeat(Math.max(0, 3 - n))}</span></small>`;
  $('teamRevives').innerHTML = `<span class="red">${pips(t.red.tokens)} RED ♥ ${t.red.revives}</span><span class="blue">BLUE ♥ ${t.blue.revives} ${pips(t.blue.tokens)}</span>`;
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
// a slightly darker version of a #rrggbb color (for snake heads)
const darker = (hex, k = 0.78) => '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
// Squares a bomb at cell c hits: within radius r (squared distance, like the server), inside the field
function blastTiles(c, r) {
  const bx = c % GW, by = (c / GW) | 0, out = [];
  for (let y = by - r; y <= by + r; y++) for (let x = bx - r; x <= bx + r; x++)
    if ((x - bx) ** 2 + (y - by) ** 2 <= r * r && x >= 0 && y >= 0 && x < GW && y < GH) out.push([x, y]);
  return out;
}
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
  // slime from the Poop item: a brownish-green smear
  ctx.fillStyle = 'rgba(128,96,36,.5)';
  for (const c of state.slime || []) roundRect(cx(c) + 1, cy(c) + 1, cs - 2, cs - 2, cs * 0.4);
  // food: regular (red), dropped by dead snakes (orange), tiny (yellow dots)
  ctx.fillStyle = '#ff4d5e';
  for (const c of state.food) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, cs * 0.38, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#ffab4d';
  for (const c of state.drops) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, cs * 0.26, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#ffd84d';
  for (const c of state.bits || []) { ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, Math.max(1.5, cs * 0.14), 0, 7); ctx.fill(); }
  // bombs: blast radius and fuse countdown
  for (const [c, left, r] of state.bombs || []) {
    const bx = cx(c) + cs / 2, by = cy(c) + cs / 2, urgent = left < 1500;
    // exactly the squares the blast will hit (same rule as the server), tinted, with a solid outline
    const tiles = blastTiles(c, r), hitSet = new Set(tiles.map(([x, y]) => x + ',' + y));
    ctx.fillStyle = `rgba(255,70,40,${urgent ? 0.3 + 0.15 * Math.sin(now / 60) : 0.24})`;
    for (const [x, y] of tiles) ctx.fillRect(view.ox + x * cs, view.oy + y * cs, cs, cs);
    ctx.strokeStyle = '#ff3b1f'; ctx.lineWidth = 2; ctx.beginPath();
    for (const [x, y] of tiles) {
      const X = view.ox + x * cs, Y = view.oy + y * cs;
      if (!hitSet.has(x + ',' + (y - 1))) { ctx.moveTo(X, Y); ctx.lineTo(X + cs, Y); }
      if (!hitSet.has(x + ',' + (y + 1))) { ctx.moveTo(X, Y + cs); ctx.lineTo(X + cs, Y + cs); }
      if (!hitSet.has((x - 1) + ',' + y)) { ctx.moveTo(X, Y); ctx.lineTo(X, Y + cs); }
      if (!hitSet.has((x + 1) + ',' + y)) { ctx.moveTo(X + cs, Y); ctx.lineTo(X + cs, Y + cs); }
    }
    ctx.stroke();
    // icon and countdown keep a readable size even when the field's squares are small
    const icon = Math.max(22, cs * 1.6), num = Math.max(20, cs * 1.5);
    { // drawn bomb (not an emoji, so it looks the same everywhere): black ball, fuse, flickering spark
      const br = icon * 0.36;
      ctx.fillStyle = '#1b1b22'; ctx.beginPath(); ctx.arc(bx, by + br * 0.15, br, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(bx - br * 0.35, by - br * 0.2, br * 0.25, 0, 7); ctx.fill();
      ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = Math.max(2, br * 0.22); ctx.beginPath(); ctx.moveTo(bx + br * 0.5, by - br * 0.6); ctx.quadraticCurveTo(bx + br, by - br * 1.3, bx + br * 1.2, by - br * 1.1); ctx.stroke();
      ctx.fillStyle = Math.floor(now / 90) % 2 ? '#ffd23f' : '#ff6a3d'; ctx.beginPath(); ctx.arc(bx + br * 1.25, by - br * 1.15, br * 0.3, 0, 7); ctx.fill();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(num)}px system-ui`; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.7)';
    const n = String(Math.max(1, Math.ceil(left / 1000))), ny = by - icon * 0.5 - num * 0.6;
    ctx.strokeText(n, bx, ny); ctx.fillStyle = urgent ? '#ffd23f' : '#fff'; ctx.fillText(n, bx, ny);
  }
  for (const f of booms) {
    const k = (now - f.t) / 450; if (k > 1) continue;
    ctx.fillStyle = `rgba(255,190,60,${0.75 * (1 - k)})`;
    for (const [x, y] of blastTiles(f.cell, f.r)) ctx.fillRect(view.ox + x * cs, view.oy + y * cs, cs, cs);
  }
  // special foods pulse, and blink during their last 3 seconds
  for (const [c, type, left, value] of state.specials) {
    if (left != null && left < 3000 && Math.floor(now / 200) % 2) continue; // feasts (left = null) never blink out
    const info = SPECIAL_INFO[type], r = cs * (0.55 + 0.1 * Math.sin(now / 150));
    ctx.fillStyle = info.color; ctx.shadowColor = info.color; ctx.shadowBlur = cs;
    ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    if (type === 'pacman') { // a little dark Pacman on the yellow ball
      const px = cx(c) + cs / 2, py = cy(c) + cs / 2, pr = cs * 0.38;
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, pr, 0.25 * Math.PI, 1.75 * Math.PI); ctx.closePath(); ctx.fill();
      continue;
    }
    const label = type === 'feast' ? '+' + value : info.icon; // a feast shows what it's worth right now
    ctx.fillStyle = '#111'; ctx.font = `800 ${Math.round(cs * (label.length > 2 ? 0.6 : 0.75))}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, cx(c) + cs / 2, cy(c) + cs / 2 + 1);
  }
  // bonus tiles, blinking in their last 3 seconds: fruit (an emoji on a soft glow) or letters (cream squares)
  for (const [c, ch, left] of state.letters || []) {
    if (left < 3000 && Math.floor(now / 200) % 2) continue;
    if (FRUIT_ICON[ch]) {
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(cx(c) + cs / 2, cy(c) + cs / 2, cs * 0.6, 0, 7); ctx.fill();
      ctx.fillStyle = '#000'; // emoji take the fill's transparency, so draw them with a solid one
      ctx.font = `${Math.round(cs * 1.05)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(FRUIT_ICON[ch], cx(c) + cs / 2, cy(c) + cs / 2 + 1);
      continue;
    }
    const pad = Math.max(1, cs * 0.06);
    ctx.fillStyle = '#f3e3b5'; ctx.strokeStyle = '#8a6d2f'; ctx.lineWidth = Math.max(1, cs * 0.08);
    ctx.beginPath(); ctx.roundRect(cx(c) + pad, cy(c) + pad, cs - pad * 2, cs - pad * 2, cs * 0.18); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#3b2a10'; ctx.font = `900 ${Math.round(cs * 0.72)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ch, cx(c) + cs / 2, cy(c) + cs / 2 + 1);
  }
  // snakes
  for (const s of state.snakes) {
    // a revived snake blinks where it will come back in for 3 s before it starts moving
    if (s.spawning && Math.floor(now / 150) % 2) continue;
    const fx = s.fx || {}, col = fx.stone ? '#9c9c9c' : colorOf(s.id), mine = s.id === myId, team = (playerOf(s.id) || {}).team;
    const hc = s.body[0], hx = cx(hc) + cs / 2, hy = cy(hc) + cs / 2;
    const [dx, dy] = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] }[s.dir];
    // Extendo tongue
    if (s.tongue && s.tongue.length) {
      ctx.strokeStyle = '#ff5c8a'; ctx.lineWidth = Math.max(2, cs * 0.28); ctx.lineCap = 'round';
      // go cell by cell; where the tongue wraps to the far side, stub it out to the edge and restart
      // it at the opposite edge instead of drawing a line across the whole field
      ctx.beginPath(); ctx.moveTo(hx, hy);
      let px = hx, py = hy;
      for (const c of s.tongue) {
        const nx = cx(c) + cs / 2, ny = cy(c) + cs / 2;
        if (Math.abs(nx - px) > cs * 1.5 || Math.abs(ny - py) > cs * 1.5) { ctx.lineTo(px + dx * cs / 2, py + dy * cs / 2); ctx.moveTo(nx - dx * cs / 2, ny - dy * cs / 2); }
        ctx.lineTo(nx, ny); px = nx; py = ny;
      }
      ctx.stroke();
      const last = s.tongue[s.tongue.length - 1], tx = cx(last) + cs / 2, ty = cy(last) + cs / 2;
      { // forked tip
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
    if (fx.pacman) { ctx.shadowColor = '#ffe14d'; ctx.shadowBlur = cs; }
    else if (fx.poop) { ctx.shadowColor = '#8a5a2b'; ctx.shadowBlur = cs * 0.8; }
    // the head is drawn a little darker than the body so it's easier to spot
    s.body.forEach((c, i) => { const pad = i === 0 ? 0 : Math.max(1, cs * 0.08); ctx.fillStyle = i === 0 ? darker(col) : col; roundRect(cx(c) + pad, cy(c) + pad, cs - pad * 2, cs - pad * 2, cs * 0.3); });
    ctx.shadowBlur = 0;
    // stone: cracked grey segments with a dark outline
    if (fx.stone) {
      ctx.strokeStyle = '#4a4a4a'; ctx.lineWidth = Math.max(1, cs * 0.1);
      s.body.forEach(c => { ctx.beginPath(); ctx.roundRect(cx(c) + 1, cy(c) + 1, cs - 2, cs - 2, cs * 0.25); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx(c) + cs * 0.3, cy(c) + cs * 0.2); ctx.lineTo(cx(c) + cs * 0.5, cy(c) + cs * 0.55); ctx.lineTo(cx(c) + cs * 0.4, cy(c) + cs * 0.8); ctx.stroke(); });
    }
    // protected after a revive: a pulsing white ring around the head
    if (fx.shield) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, cs * 0.18); ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 90); ctx.beginPath(); ctx.arc(hx, hy, cs * 1.1, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
    // team matches: the head carries a ring in the pure team color
    if (team) { ctx.strokeStyle = TEAM_COLOR[team]; ctx.lineWidth = Math.max(2, cs * 0.14); ctx.beginPath(); ctx.roundRect(cx(hc) - 1, cy(hc) - 1, cs + 2, cs + 2, cs * 0.35); ctx.stroke(); }
    // Pacman: the head becomes a yellow chomping Pacman facing the way it's going
    if (fx.pacman) {
      const open = 0.15 + 0.25 * Math.abs(Math.sin(now / 90)), ang = Math.atan2(dy, dx), r = cs * 0.7;
      ctx.fillStyle = '#ffe14d'; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.arc(hx, hy, r, ang + open * Math.PI, ang - open * Math.PI + 2 * Math.PI); ctx.closePath(); ctx.fill();
    }
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
  if (e.key === 't' || e.key === 'T') { $('chatBox').classList.remove('hidden'); $('chat').focus(); updateChat(); e.preventDefault(); return; } // T opens chat
  if (e.key === ' ') {
    // Space: host starts a round between rounds; during a round it uses your next held item
    if (roomState === 'lobby') { if (myId === hostId) net({ t: 'start' }); }
    else net({ t: 'use' });
    e.preventDefault(); return;
  }
  // NOKIA (numpad 1 / 9) and VIM (H / L) steering: two keys that turn relative to where you're heading;
  // the server works out the actual direction (see snake.js)
  const scheme = SW.snakeKeys();
  // NOKIA uses the numeric keypad's 1 and 9 only (never the 1/9 in the top row). e.code is Numpad1/Numpad9
  // with Num Lock on or off; e.location 3 (keypad) covers browsers that report the key as End/PageUp.
  const pad = e.location === 3 || /^Numpad/.test(e.code);
  const nokia = pad && (e.code === 'Numpad1' || e.key === 'End' || (e.key === '1' && e.location === 3)) ? 'a'
    : pad && (e.code === 'Numpad9' || e.key === 'PageUp' || (e.key === '9' && e.location === 3)) ? 'b' : null;
  const rel = scheme === 'nokia' ? nokia : scheme === 'vim' ? { h: 'a', l: 'b' }[e.key.toLowerCase()] : null;
  if (rel) { net({ t: 'dir', rel }); e.preventDefault(); return; }
  const d = steerKey(e.key);
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
$('teamChoiceBtn').onclick = e => { net({ t: 'teamchoice', mode: teamChoice === 'choose' ? 'random' : 'choose' }); e.target.blur(); };
$('tilesBtn').onclick = e => { const order = ['fruit', 'letters', 'none']; net({ t: 'tiles', mode: order[(order.indexOf(tileMode) + 1) % 3] }); e.target.blur(); };
// Leave the room for real: tell the server first (so it drops you immediately), then close.
function leaveRoom() { try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'leave' })); ws.close(); } } catch {} }
window.addEventListener('pagehide', leaveRoom); // tab closed, reloaded, browser back, or Back to lobby
// Back to the homepage. Leaving while still alive in a round means dying, so ask first.
$('leaveBtn').onclick = e => {
  const alive = roomState !== 'lobby' && state.snakes.some(s => s.id === myId);
  if (alive && !confirm('Leave this round? Your snake will be out.')) { e.target.blur(); return; }
  leaveRoom(); location.href = '/';
};
SW.mountSettings($('themeBar')); // ⚙ Settings: theme + controls, saved per browser
SW.onChange(() => { readTheme(); renderKeysHelp(); });
// a new avatar picked in ⚙ Settings shows up for everyone in the room straight away
let sentAvatar = SW.avatar(), sentShade = SW.teamShade();
SW.onChange(() => { if (SW.teamShade() !== sentShade) { sentShade = SW.teamShade(); if (sentShade != null) net({ t: 'shade', i: sentShade }); } });
SW.onChange(() => { if (SW.avatar() !== sentAvatar) { sentAvatar = SW.avatar(); net({ t: 'avatar', a: sentAvatar }); } });
renderKeysHelp();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);
$('specialList').innerHTML = Object.entries(SPECIAL_INFO).map(([k, s]) => `<li><span class="ic" style="background:${s.color}">${iconHtml(k, s)}</span><span><b>${s.name}</b> – ${s.desc}</span></li>`).join('');

readTheme(); renderItems(); connect(); requestAnimationFrame(draw);
})();
