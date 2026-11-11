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
  podium: { desc: 'top 3 players in this lobby by wins', run: podium },
  leaderboard: { alias: 'podium', run: podium },
  // games that support it pass ctx.spectate (toggles sitting out, returns the reply); Snakewar only for now
  spectate: { desc: 'sit out the next rounds and just watch; type it again to play (Snakewar)', run: ctx => [ctx.spectate ? ctx.spectate() : 'Spectating is only in Snakewar for now.'] },
};

// Returns true if msg was a command (it's then handled and must not be sent as chat).
function handle(msg, ctx, reply) {
  const m = /^\s*\/(\S*)/.exec(String(msg || ''));
  if (!m) return false;
  const name = m[1].toLowerCase(), cmd = COMMANDS[name];
  const lines = !name ? listCommands() // just "/" lists everything too
    : cmd ? cmd.run({ ...ctx, players: [...ctx.players] })
    : [`Unknown command /${name}. Type /help for the list.`];
  for (const line of lines) reply(line);
  return true;
}

module.exports = { handle, COMMANDS };
