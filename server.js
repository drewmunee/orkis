// Stackwar server: static files + WebSocket rooms.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const leaderboard = require('./leaderboard');
const settings = require('./settings');
const moderation = require('./moderation');
const swearjar = require('./swearjar');
const commands = require('./commands');
const avatars = require('./avatars');
const stackbots = require('./stackbot');
const homechat = require('./homechat');
const daily = require('./daily');
const stats = require('./stats');
const db = require('./db');
const { validBid } = db;
const snake = require('./snake');
const block = require('./block');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MAX_PLAYERS = 6;
const COUNTDOWN_MS = 3000; // the client's 3-2-1 before pieces fall (game.js COUNTDOWN_MS)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/api/lobbies') {
    // homepage lobby browser: every open lobby per game
    const stackwar = [...rooms.values()].filter(r => !r.daily).map(r => ({ room: r.code, players: r.players.size, names: [...r.players.values()].map(q => (q.bot ? '🤖 ' : '') + q.name), playing: r.state !== 'lobby', teamMode: !!r.teamMode }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ stackwar, snakewar: snake.lobbies(), blockwar: block.lobbies() }));
  }
  const q = new URL(req.url, 'http://x').searchParams;
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (p === '/api/leaderboard') {
    // top 10 for one game: ?game=stackwar | snakewar | blockwar (default stackwar)
    const game = leaderboard.GAMES.includes(q.get('game')) ? q.get('game') : q.get('game') === 'snake' ? 'snakewar' : 'stackwar';
    leaderboard.top(game).then(rows => json(200, rows), err => { console.error('leaderboard read failed:', err.message); json(500, []); });
    return;
  }
  if (p === '/api/daily') {
    // Stackwar daily run: today's top 10 times
    const day = daily.today();
    Promise.all([daily.top(day), daily.hall()]).then(([top, hall]) => json(200, { day, goal: daily.GOAL, resetsInMs: daily.msUntilReset(), top, hall }),
      e => { console.error('daily read failed:', e.message); json(500, { error: 'unavailable' }); });
    return;
  }
  if (p === '/api/chat') {
    // homepage chat: GET ?after=<id> for newer lines, POST {bid, name, msg} to say something
    if (req.method === 'GET') { homechat.since(q.get('after')).then(lines => json(200, lines), e => { console.error('chat read failed:', e.message); json(500, []); }); return; }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        let m; try { m = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        homechat.post(m).then(() => json(200, { ok: true }), e => json(400, { error: e.message }));
      });
      return;
    }
    return json(405, { error: 'method not allowed' });
  }
  if (p === '/api/stats') {
    // all-time stats for one browser: ?bid=<browser id>
    const bid = q.get('bid');
    if (!validBid(bid)) return json(400, { error: 'bad id' });
    Promise.all([stats.forBrowser(bid), swearjar.mine(bid), swearjar.total(), daily.placings(bid)])
      .then(([s, mine, total, placed]) => {
        // daily-run wins / podium finishes are worked out from the daily boards (finished days only)
        if (placed.wins || placed.podiums || (s.games.stackwar && s.games.stackwar.daily_runs)) s.games.stackwar = { ...(s.games.stackwar || {}), daily_wins: placed.wins, daily_podiums: placed.podiums };
        json(200, { ...s, swearJar: { mine, total } });
      }, e => { console.error('stats read failed:', e.message); json(500, { error: 'unavailable' }); });
    return;
  }
  if (p === '/api/name-ok') {
    // the homepage checks a username before joining
    const name = String(q.get('name') || '').trim().slice(0, 14);
    if (!moderation.nameAllowed(name)) return json(200, { ok: false, msg: moderation.NAME_REFUSED });
    // and nobody else in the lobby they're about to join already has it
    const code = String(q.get('room') || 'lobby').trim().toLowerCase().slice(0, 20) || 'lobby';
    const map = { stackwar: rooms, snakewar: snake._rooms, blockwar: block._rooms }[q.get('game')];
    const r = map && map.get(code);
    if (r && moderation.nameClash(r.players.values(), name, q.get('bid')) === 'taken') return json(200, { ok: false, msg: moderation.nameTaken(name) });
    return json(200, { ok: true });
  }
  if (p === '/api/settings') {
    // per-browser settings: GET ?bid=<browser id>, POST {bid, settings}
    if (req.method === 'GET') { settings.get(q.get('bid')).then(d => json(200, d), e => json(400, { error: e.message })); return; }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > settings.MAX_BYTES * 2) req.destroy(); });
      req.on('end', () => {
        let m; try { m = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        settings.set(m.bid, m.settings).then(() => json(200, { ok: true }), e => json(400, { error: e.message }));
      });
      return;
    }
    return json(405, { error: 'method not allowed' });
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> room
let nextId = 1;

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, exceptId) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, msg);
}
function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, wins: p.wins, team: p.team || null, avatar: p.avatar || null, bot: p.bot || null, spectating: !!p.spectating }));
}
function sendLobby(room) {
  broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId, state: room.state, teamMode: !!room.teamMode });
}
function freeSlot(room) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return 0;
}
// A game started with only one player is a solo run: the server counts that player's
// cleared lines itself and records the total on the leaderboard when the run ends.
function finishSolo(room, p) {
  if (room.state !== 'playing' || room.startCount !== 1 || !p.alive || room.daily) return;
  const lines = p.lines;
  if (lines < 1) return send(p.ws, { t: 'solo', lines: 0 });
  // sanity check: nobody clears more than ~3 lines a second over a whole run
  const secs = (Date.now() - (room.startedAt || Date.now())) / 1000;
  if (lines > Math.max(8, secs * 3)) { console.warn(`ignored implausible Stackwar score ${lines} in ${secs.toFixed(0)} s from ${p.name}`); return send(p.ws, { t: 'solo', lines, error: true }); }
  stats.best(p, 'stackwar', 'best_solo', lines);
  leaderboard.submit('stackwar', p, lines).then(
    r => send(p.ws, { t: 'solo', lines, ...r }),
    err => { console.error('leaderboard write failed:', err.message); send(p.ws, { t: 'solo', lines, error: true }); });
}
// Daily run: 40 lines cleared. The server times it (from the end of the 3-2-1 countdown to the clear
// that reached 40), records the best time of the day, and ends the run.
function finishDaily(room, p) {
  const ms = Date.now() - room.startedAt;
  room.state = 'lobby'; p.alive = false;
  if (ms < daily.MIN_MS) { console.warn(`ignored implausible daily time ${ms} ms from ${p.name}`); send(p.ws, { t: 'daily', ms, error: true }); }
  else {
    stats.add(p, 'stackwar', 'daily_finishes');
    const firstTry = p.dailyAttempt === 1 && !p.restarted;
    daily.submit(room.dailyDay, p, ms, firstTry).then(r => send(p.ws, { t: 'daily', ms, firstTry, ...r }),
      e => { console.error('daily write failed:', e.message); send(p.ws, { t: 'daily', ms, error: true }); });
  }
  broadcast(room, { t: 'gameover', winnerId: null, winnerName: null, daily: true });
  sendLobby(room);
}
function startRoom(room) {
  // players who typed /spectate sit this game out and watch; everyone else plays
  const playing = [...room.players.values()].filter(p => !p.spectating);
  if (!playing.length) return broadcast(room, { t: 'log', msg: 'Everyone is spectating: type /spectate to play.' });
  room.state = 'playing';
  room.startCount = playing.length;
  room.startedAt = Date.now();
  room.startedWith = playing; // who played this game (for whether a win counts)
  for (const p of playing) stats.add(p, 'stackwar', { played: 1, [room.daily ? 'daily_runs' : playing.length === 1 ? 'solo_runs' : room.teamMode ? 'team_games' : 'ffa_games']: 1 });
  let seed = (Math.random() * 2 ** 31) | 0;
  if (room.daily) {
    room.dailyDay = daily.today(); seed = daily.seedFor(room.dailyDay); room.startedAt = Date.now() + COUNTDOWN_MS;
    // count the attempt; a time set on attempt 1 earns the ⚡ first-try badge
    for (const p of room.players.values()) { p.dailyAttempt = null; daily.attempt(room.dailyDay, p).then(n => { p.dailyAttempt = n; }, e => console.error('daily attempt write failed:', e.message)); }
  }
  for (const p of room.players.values()) { p.alive = !p.spectating; p.board = ''; p.lines = 0; p.team = null; }
  room.firstFourDone = !!room.daily; // first 4-line clear of each match earns a bonus (never in the daily run: same run for everyone)
  // Team mode: shuffle everyone into red and blue (sizes differ by at most one), new teams every match.
  // Teams only decide the winner; garbage and specials work exactly as in a free-for-all.
  room.teamMatch = !!room.teamMode && room.startCount >= 2;
  const order = playing.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
  order.forEach((p, i) => { p.team = room.teamMatch ? (i % 2 ? 'blue' : 'red') : null; });
  broadcast(room, { t: 'start', seed, players: playerList(room), teamMatch: room.teamMatch, daily: room.daily ? { goal: daily.GOAL, day: room.dailyDay } : null });
  if (room.teamMatch) for (const team of ['red', 'blue'])
    broadcast(room, { t: 'log', msg: `${team === 'red' ? 'Red' : 'Blue'} team: ${order.filter(p => p.team === team).map(p => p.name).join(', ')}` });
  sendLobby(room);
}
// A win only goes into someone's stats if they beat at least one other person or one insane bot (beating
// only easy / medium bots doesn't count). Opponents = everyone who started the game, minus their own team.
function winCounts(room, p) {
  return (room.startedWith || []).some(q => q !== p && !(room.teamMatch && q.team === p.team) && (!q.bot || q.bot === 'insane'));
}
// The host can hand the host role to another person (click their number, or /host N). Returns the reply.
function makeHost(room, me, target) {
  if (me.id !== room.hostId) return 'Only the host can do that.';
  if (!target || !room.players.has(target.id)) return 'That player isn\'t here.';
  if (target.bot) return 'Bots can\'t be host.';
  if (target === me) return 'You\'re already the host.';
  room.hostId = target.id;
  broadcast(room, { t: 'log', msg: `${me.name} made ${target.name} the host` });
  sendLobby(room);
  return `${target.name} is now the host.`;
}
function checkGameOver(room) {
  if (room.state !== 'playing') return;
  const alive = [...room.players.values()].filter(p => p.alive);
  if (room.teamMatch) {
    // team match: over once everyone left standing is on one team (or nobody is)
    const teams = new Set(alive.map(p => p.team));
    if (teams.size > 1) return;
    room.state = 'lobby';
    for (const p of room.players.values()) p.alive = false;
    const winnerTeam = alive.length ? alive[0].team : null;
    for (const p of room.players.values()) if (winnerTeam && p.team === winnerTeam && winCounts(room, p)) stats.add(p, 'stackwar', 'wins_team');
    broadcast(room, { t: 'gameover', winnerTeam });
    sendLobby(room);
    return;
  }
  const over = room.startCount > 1 ? alive.length <= 1 : alive.length === 0;
  if (!over) return;
  room.state = 'lobby';
  const winner = room.startCount > 1 ? alive[0] : null;
  if (winner) { winner.wins++; if (winCounts(room, winner)) stats.add(winner, 'stackwar', 'wins_ffa'); }
  for (const p of room.players.values()) p.alive = false;
  broadcast(room, { t: 'gameover', winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : null });
  sendLobby(room);
}

// Heartbeat: every 20 s, drop any connection that didn't answer the last ping. This clears out players
// whose browser went away without the connection closing properly (e.g. through Render's proxy), so
// they don't linger in lobbies.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 20000);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const me = { id: nextId++, ws, name: '', slot: 0, alive: false, board: '', wins: 0, lines: 0 };
  let room = null;
  let snakeConn = null; // set when this connection plays Snakewar (or Blockwar) instead of Stackwar

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // a player leaving on purpose (Back to lobby, closing the tab): drop them right away rather than
    // waiting for the connection to close; the close handler below does the cleanup for every game
    if (m.t === 'leave') return ws.terminate();
    if (snakeConn) return snakeConn.message(m);
    // usernames may not contain racial slurs (every game's join comes through here)
    if (m.t === 'join' && !moderation.nameAllowed(String(m.name || '').trim().slice(0, 14))) return send(ws, { t: 'error', msg: moderation.NAME_REFUSED });
    if (m.t === 'join' && m.game === 'snake') { if (!room) snakeConn = snake.join(ws, me.id, m) || { message() {}, close() {} }; return; } // a Snakewar connection never falls through to Stackwar
    if (m.t === 'join' && m.game === 'block') { if (!room) snakeConn = block.join(ws, me.id, m) || { message() {}, close() {} }; return; } // same for Blockwar

    if (m.t === 'join') {
      if (room) return;
      // a daily run gets its own private room (hidden from the lobby list, nobody else can join it)
      const code = m.daily ? `daily-${me.id}-${Math.random().toString(36).slice(2, 7)}` : String(m.room || 'lobby').trim().toLowerCase().slice(0, 20) || 'lobby';
      room = rooms.get(code);
      if (room && room.daily) { send(ws, { t: 'error', msg: 'That is someone\'s private daily run.' }); room = null; return; }
      if (!room) { room = { code, players: new Map(), hostId: me.id, state: 'lobby', startCount: 0, daily: !!m.daily }; rooms.set(code, room); }
      const wanted = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
      const clash = moderation.nameClash(room.players.values(), wanted, m.bid);
      if (clash === 'taken') { send(ws, { t: 'error', msg: moderation.nameTaken(wanted) }); room = null; return; }
      if (clash) clash.ws.terminate(); // same browser rejoining: drop its old connection
      const slot = freeSlot(room);
      if (!slot) { send(ws, { t: 'error', msg: 'Room is full (6 players max).' }); room = null; return; }
      me.name = wanted;
      me.avatar = avatars.clean(m.avatar);
      me.bid = typeof m.bid === 'string' ? m.bid.slice(0, 40) : null; // browser ID: one leaderboard spot per browser
      me.slot = slot;
      // Stackwar bots (stackbot.js) join through the server's own fake sockets; a browser can't claim to be one
      if (ws.isBot && stackbots.LEVELS[m.bot]) me.bot = m.bot;
      room.players.set(me.id, me);
      send(ws, { t: 'welcome', id: me.id, room: code });
      sendLobby(room);
      // let a late joiner see current boards
      for (const p of room.players.values()) if (p.board && p.id !== me.id) send(ws, { t: 'board', id: p.id, cells: p.board });
      if (room.daily) startRoom(room); // the daily run starts right away
      return;
    }
    if (!room) return;

    switch (m.t) {
      case 'start':
        if (me.id !== room.hostId || room.state !== 'lobby') return;
        startRoom(room);
        break;
      case 'addbot': { // host, between games: add a bot (easy / medium / insane); never in daily runs
        if (me.id !== room.hostId || room.state !== 'lobby' || room.daily || me.bot) return;
        if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'log', msg: 'The room is full (6 players max).' });
        stackbots.addBot(room.code, m.level, [...room.players.values()].map(p => p.name), sock => wss.emit('connection', sock));
        break;
      }
      case 'removebot': { // the host (whoever it is now) can remove a bot at any time; mid-game it counts as out
        if (me.id !== room.hostId) return;
        const b = room.players.get(m.id);
        if (b && b.bot) b.ws.terminate();
        break;
      }
      case 'sethost': { // host clicked another player's number
        const reply = makeHost(room, me, room.players.get(m.id));
        if (room.hostId !== m.id) send(ws, { t: 'log', msg: reply });
        break;
      }
      case 'endgame': { // host: once no people are left playing, stop the bots playing on
        if (me.id !== room.hostId || room.state !== 'playing') return;
        if ([...room.players.values()].some(p => p.alive && !p.bot)) return;
        room.state = 'lobby';
        for (const p of room.players.values()) p.alive = false;
        broadcast(room, { t: 'log', msg: `${me.name} ended the game` });
        broadcast(room, { t: 'gameover', winnerId: null, winnerName: null });
        sendLobby(room);
        break;
      }
      case 'restart': // daily run only: R starts a fresh attempt at any time, even mid-run
        if (!room.daily || me.id !== room.hostId) return;
        me.restarted = true; // a restarted run can never earn the ⚡ first-try badge
        startRoom(room);
        break;
      case 'avatar': // picked a new avatar in ⚙ Settings
        me.avatar = avatars.clean(m.a); sendLobby(room);
        break;
      case 'teammode':
        if (me.id !== room.hostId || room.state !== 'lobby' || room.daily) return;
        room.teamMode = !!m.on;
        // drop last match's Red/Blue labels so the lobby never shows teams that won't be used
        for (const p of room.players.values()) p.team = null;
        sendLobby(room);
        break;
      case 'board':
        if (typeof m.cells !== 'string' || m.cells.length > 400) return;
        me.board = m.cells;
        broadcast(room, { t: 'board', id: me.id, cells: m.cells }, me.id);
        break;
      case 'lines': {
        // Multi-line clears send garbage rows to every other living player.
        if (!me.alive) return;
        const n = Math.min(4, Math.max(0, m.count | 0)); // one piece can clear at most 4 lines
        me.lines += n;
        if (n) stats.add(me, 'stackwar', { lines: n, [['', 'singles', 'doubles', 'triples', 'tetrises'][n]]: 1 });
        if (room.daily) { if (me.lines >= daily.GOAL) finishDaily(room, me); return; } // daily run: no garbage, just the race to 40
        let garbage = n >= 4 ? 3 : n === 3 ? 2 : n === 2 ? 1 : 0;
        // The match's first 4-line clear sends 4 lines instead of 3 and earns a free special.
        const firstFour = n >= 4 && !room.firstFourDone;
        // In a team match the bonus special goes to every living player on the clearer's team.
        const team = room.teamMatch ? me.team : null;
        const mates = p => team && p.team === team;
        if (firstFour) {
          room.firstFourDone = true; garbage = 4; stats.add(me, 'stackwar', 'first_tetris_bonus');
          for (const p of room.players.values()) if (p.alive && (p.id === me.id || mates(p))) send(p.ws, { t: 'bonus' });
        }
        if (!garbage) return;
        // Teammates only ever get 1 garbage line, and it almost always carries a special (a gift, really).
        for (const p of room.players.values())
          if (p.id !== me.id && p.alive) { const g = mates(p) ? 1 : garbage; stats.add(me, 'stackwar', 'garbage_sent', g); send(p.ws, mates(p) ? { t: 'garbage', count: 1, from: me.id, rich: true } : { t: 'garbage', count: garbage, from: me.id }); }
        const tName = t => t === 'red' ? 'Red' : 'Blue', other = team === 'red' ? 'blue' : 'red';
        const to = team ? `+${garbage} to ${tName(other)}, +1 to ${tName(team)}` : `+${garbage} to all`;
        broadcast(room, { t: 'log', msg: firstFour
          ? `${me.name} got the first 4-line clear → ${to} and a bonus special${team ? ` for team ${tName(team)}` : ''}`
          : `${me.name} cleared ${n} lines → ${to}` });
        break;
      }
      case 'special': {
        if (!me.alive) return;
        const target = [...room.players.values()].find(p => p.slot === (m.slot | 0));
        if (!target || !target.alive) return;
        const type = String(m.special).slice(0, 1);
        if (type === 'S') {
          // swap boards: server holds the latest copy of each
          if (target.id !== me.id) {
            const a = me.board, b = target.board;
            send(me.ws, { t: 'setboard', cells: b });
            send(target.ws, { t: 'setboard', cells: a });
          }
        } else {
          send(target.ws, { t: 'special', special: type, from: me.id });
        }
        broadcast(room, { t: 'used', special: type, from: me.id, to: target.id });
        if (target.id === me.id) stats.add(me, 'stackwar', 'specials_self');
        else { stats.add(me, 'stackwar', 'specials_sent'); stats.add(target, 'stackwar', 'specials_received'); }
        break;
      }
      case 'dead':
        if (!me.alive) return;
        stats.add(me, 'stackwar', 'topouts');
        finishSolo(room, me);
        if (room.daily) send(ws, { t: 'daily', failed: true, lines: me.lines }); // topped out before 40
        me.alive = false;
        broadcast(room, { t: 'dead', id: me.id });
        checkGameOver(room);
        break;
      case 'chat':
        // /commands (see commands.js) answer only the sender and aren't chat
        if (commands.handle(m.msg, { me, players: room.players.values(), game: 'stackwar', setHost: t => makeHost(room, me, t), spectate: () => {
          if (room.daily) return 'There is nothing to spectate in a daily run.';
          me.spectating = !me.spectating;
          sendLobby(room);
          broadcast(room, { t: 'log', msg: me.spectating ? `${me.name} is spectating` : `${me.name} is back in the game` });
          return me.spectating ? `You'll watch the next games instead of playing${me.alive ? ' (after this one)' : ''}. Type /spectate again to play.` : 'You\'ll play in the next game.';
        } }, line => send(ws, { t: 'log', msg: line }))) break;
        broadcast(room, { t: 'chat', id: me.id, msg: String(m.msg).slice(0, 200) });
        if (moderation.hasSwear(m.msg)) swearjar.addQuarter(me).then(line => { if (line) broadcast(room, { t: 'log', msg: line }); }, e => console.error('swear jar failed:', e.message)); // a quarter in the jar
        break;
    }
  });

  ws.on('close', () => {
    if (snakeConn) return snakeConn.close();
    if (!room) return;
    finishSolo(room, me); // a solo player closing the tab still gets their run recorded
    room.players.delete(me.id);
    const people = [...room.players.values()].filter(p => !p.bot);
    if (!people.length) { // only bots (or nobody) left: close the room and send the bots home
      rooms.delete(room.code);
      for (const p of [...room.players.values()]) p.ws.terminate();
      return;
    }
    if (room.hostId === me.id) room.hostId = people[0].id; // the host is always a person
    if (me.alive) { me.alive = false; broadcast(room, { t: 'dead', id: me.id }); }
    broadcast(room, { t: 'log', msg: `${me.name} left` });
    checkGameOver(room);
    sendLobby(room);
  });
});

// Apply any new database migrations before taking players. If one fails, exit without listening:
// Render then keeps the previous version running and the database is left as it was.
db.ready().then(() => server.listen(PORT, () => console.log(`Stackwar running on http://localhost:${PORT}`)), e => {
  console.error(e.message);
  process.exit(1);
});

// Render stops the old server with SIGTERM when a new version goes live. Close every connection first
// (so solo runs in progress get recorded like a closed tab), then save buffered stats before exiting.
let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: saving data and shutting down`);
  server.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise(r => setTimeout(r, 1500)); // let close handlers send their leaderboard writes
  for (let i = 0; i < 3 && stats.unsaved(); i++) await stats.flush();
  if (stats.unsaved()) console.error(`shutdown: ${stats.unsaved()} stat entries could not be saved`);
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
