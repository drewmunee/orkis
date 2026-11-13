// Chat commands, shared by every game. A chat message starting with '/' is a command instead of chat:
// one word (no spaces), any capitalization, e.g. /podium or /PODIUM. Anything typed after the first word
// is ignored. Commands work the same in every game; only what they show depends on the game and room.
// Replies go only to the player who typed the command (as log lines), so nobody's chat gets spammed.
//
// To add a command: add an entry to COMMANDS with a short description and run(ctx), which returns the
// lines to show. ctx = { me, players: [...the room's players], game: 'stackwar' | 'snakewar' | 'blockwar' }
// plus optional per-game hooks (spectate).
const GAME_NAMES = { stackwar: 'Stackwar', snakewar: 'Snakewar', blockwar: 'Blockwar' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stats = require('./stats');

// /leaderboard: the people in this lobby ranked by their all-time wins in this game (every wins_* stat:
// free-for-all, team, clear race, lives...). Bots have no stats and aren't listed.
async function allTimeWins({ players, game }) {
  const people = players.filter(p => !p.bot);
  const rows = await Promise.all(people.map(async p => {
    const s = (await stats.forBrowser(p.bid, p.name)).games[game] || {};
    return { name: p.name, wins: Object.entries(s).filter(([k]) => k.startsWith('wins_')).reduce((n, [, v]) => n + v, 0) };
  }));
  const ranked = rows.filter(r => r.wins > 0).sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name)).slice(0, 3);
  if (!ranked.length) return [`🏆 Nobody in this lobby has won a ${GAME_NAMES[game]} game yet.`];
  const medals = ['🥇', '🥈', '🥉'];
  return ['🏆 All-time ' + GAME_NAMES[game] + ' wins in this lobby: ' + ranked.map((r, i) => `${medals[i]} ${r.name} (${plural(r.wins, 'win')})`).join('  ')];
}

function podium({ players, game }) {
  // top 3 by wins in this room (wins reset when a player leaves and rejoins)
  const ranked = players.filter(p => p.wins > 0).sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name)).slice(0, 3);
  if (!ranked.length) return [`🏆 No ${GAME_NAMES[game]} wins in this lobby yet.`];
  const medals = ['🥇', '🥈', '🥉'];
  return [`🏆 Most wins in this lobby: ` + ranked.map((p, i) => `${medals[i]} ${p.name} (${plural(p.wins, 'win')})`).join('  ')];
}

// every command with its other names, e.g. "/help or /list or /? – list the chat commands"
const listCommands = () => ['Commands: ' + Object.entries(COMMANDS).filter(([, c]) => !c.alias).map(([n, c]) => {
  const also = Object.keys(COMMANDS).filter(k => COMMANDS[k].alias === n).map(k => ' or /' + k).join('');
  return `/${n}${also} – ${c.desc}`;
}).join(' · ')];

const COMMANDS = {
  help: { desc: 'list the chat commands', run: () => listCommands() },
  list: { alias: 'help', run: () => listCommands() },
  '?': { alias: 'help', run: () => listCommands() },
  podium: { desc: 'top 3 players in this lobby by wins this session', run: podium },
  leaderboard: { desc: 'top 3 players in this lobby by all-time wins in this game', run: allTimeWins },
  // games that support it pass ctx.spectate (toggles sitting out, returns the reply): Stackwar and Snakewar
  host: { desc: 'make another player host: /host 2 or /host two (numbers as in the player list, 1 = you)', run: hostCmd },
  spectate: { desc: 'sit out the next games and just watch; type it again to play (Stackwar, Snakewar)', run: ctx => [ctx.spectate ? ctx.spectate() : 'Spectating isn\'t available in this game yet.'] },
};

// /host N: hand the host role to player number N (per viewer, like the player list: 1 = you, then everyone
// else in join-slot order). Accepts digits or words. Each game passes ctx.setHost(player) -> reply line.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function hostCmd(ctx, args) {
  if (!ctx.setHost) return ['Changing the host isn\'t available here.'];
  const word = String(args[0] || '').toLowerCase().replace(/^#/, '');
  const n = /^\d+$/.test(word) ? +word : NUMBER_WORDS.indexOf(word);
  if (!(n >= 1)) return ['Type /host and a player\'s number from the player list, e.g. /host 2 or /host two.'];
  const order = [ctx.me, ...ctx.players.filter(p => p !== ctx.me).sort((a, b) => a.slot - b.slot)];
  const target = order[n - 1];
  if (!target) return [`There's no player ${n} in this lobby.`];
  return [ctx.setHost(target)];
}

// Returns true if msg was a command (it's then handled and must not be sent as chat).
function handle(msg, ctx, reply) {
  const m = /^\s*\/(\S*)\s*(.*)$/.exec(String(msg || ''));
  if (!m) return false;
  const name = m[1].toLowerCase(), cmd = COMMANDS[name], args = m[2].trim().split(/\s+/).filter(Boolean);
  const lines = !name ? listCommands() // just "/" lists everything too
    : cmd ? cmd.run({ ...ctx, players: [...ctx.players] }, args)
    : [`Unknown command /${name}. Type /help for the list.`];
  // a command may answer later (e.g. /leaderboard reads saved stats)
  Promise.resolve(lines).then(ls => { for (const line of ls) reply(line); }, e => { console.error('command failed:', e.message); reply('That command failed, try again in a moment.'); });
  return true;
}

module.exports = { handle, COMMANDS };
