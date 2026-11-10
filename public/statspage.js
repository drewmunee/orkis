// Stats page: everything recorded for this browser, grouped by game.
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => Number(n || 0).toLocaleString();

// [stat key, label, kind] - kind 'best' highlights personal records; functions compute from other stats
const LAYOUT = {
  stackwar: { title: 'STACKWAR', sections: [
    ['Games', [['played', 'Games played'], ['wins_ffa', 'Free-for-all wins'], ['wins_team', 'Team wins'], ['ffa_games', 'Free-for-all games'], ['team_games', 'Team games'], ['solo_runs', 'Solo runs']]],
    ['Line clears', [['lines', 'Lines cleared'], ['tetrises', 'Tetrises (4 lines)'], ['triples', 'Triples'], ['doubles', 'Doubles'], ['singles', 'Singles'], ['best_solo', 'Best solo run (lines)', 'best']]],
    ['Battle', [['garbage_sent', 'Garbage lines sent'], ['first_tetris_bonus', 'First 4-line bonuses'], ['topouts', 'Times topped out'], ['specials_sent', 'Specials sent'], ['specials_received', 'Specials received'], ['specials_self', 'Specials used on self']]],
  ] },
  snakewar: { title: 'SNAKEWAR', sections: [
    ['Games', [['played', 'Games played'], ['wins_ffa', 'Free-for-all wins'], ['wins_team', 'Team wins'], ['ffa_games', 'Free-for-all games'], ['team_games', 'Team games'], ['classic_runs', 'Classic solo runs']]],
    ['Hunting', [['kills', 'Kills'], [s => s.deaths ? (s.kills || 0) / s.deaths : (s.kills || 0), 'Kills per death', 'ratio'], ['tongue_kills', 'Tongue kills'], ['blockade_kills', 'Blockade kills'], ['bomb_hits', 'Snakes bombed'], ['longest', 'Longest snake', 'best']]],
    ['Deaths', [['deaths', 'Deaths'], ['deaths_self', 'Ran into yourself'], ['deaths_snake', 'Killed by a snake'], ['deaths_head_on', 'Head-on crashes'], ['deaths_tongue', 'Caught by a tongue'], ['deaths_blockade', 'Hit a blockade'], ['deaths_shrink', 'Caught by the shrink'], ['deaths_wall', 'Hit the wall (classic)'], ['bombed', 'Times bombed']]],
    ['Eating & items', [['food', 'Food eaten'], ['remains_eaten', 'Snake remains eaten'], ['tiny_food', 'Tiny food eaten'], ['tongue_food', 'Food licked up (Extendo)'], ['specials', 'Specials picked up'], ['ghosts_used', 'Ghosts used'], ['blockades_placed', 'Blockades placed'], ['bombs_dropped', 'Bombs dropped'], ['best_classic', 'Best classic score', 'best']]],
    ['Team play', [['tokens', 'Revive tokens'], ['revives_earned', 'Revives earned'], ['times_revived', 'Times revived']]],
  ] },
  blockwar: { title: 'BLOCKWAR', sections: [
    ['Games', [['played', 'Games played'], ['wins_clear', 'Clear race wins'], ['wins_lives', 'Lives wins'], ['clear_games', 'Clear races'], ['lives_games', 'Lives games'], ['solo_runs', 'Solo runs']]],
    ['Breaking', [['blocks', 'Blocks broken'], ['lives_lost', 'Lives lost'], ['best_solo', 'Best solo score', 'best'], ['best_level', 'Best solo level', 'best']]],
    ['Specials', [['specials_sent', 'Specials sent'], ['specials_received', 'Specials received'], ['specials_self', 'Used on self']]],
  ] },
};

function render(d) {
  const games = d.games || {}, sum = k => Object.values(games).reduce((n, g) => n + (g[k] || 0), 0);
  const wins = Object.values(games).reduce((n, g) => n + Object.entries(g).filter(([k]) => k.startsWith('wins_')).reduce((m, [, v]) => m + v, 0), 0);
  $('who').innerHTML = d.name ? `Playing as <b>${esc(d.name)}</b>${d.since ? ` · since ${new Date(d.since).toLocaleDateString()}` : ''}` : 'No games played on this browser yet. Go play something!';
  const jar = d.swearJar || { mine: 0, total: 0 };
  $('totals').innerHTML = [[fmt(sum('played')), 'Games played'], [fmt(wins), 'Wins'], ['$' + (jar.mine / 4).toFixed(2), 'Your swear jar'], ['$' + (jar.total / 4).toFixed(2), 'Everyone\'s swear jar']]
    .map(([v, l]) => `<div class="total"><b>${v}</b><span>${l}</span></div>`).join('');
  $('games').innerHTML = Object.entries(LAYOUT).map(([id, g]) => {
    const s = games[id] || {};
    const body = !s.played ? '<p class="empty">Not played yet.</p>' : g.sections.map(([name, rows]) => `<h3>${name}</h3><div class="grid">${rows.map(([key, label, kind]) => {
      const v = typeof key === 'function' ? key(s).toFixed(2) : fmt(s[key]);
      return `<div class="stat${kind === 'best' ? ' best' : ''}"><b>${v}</b><span>${label}</span></div>`;
    }).join('')}</div>`).join('');
    return `<section class="game"><h2 class="${id}">${g.title}</h2>${body}</section>`;
  }).join('');
}

fetch('/api/stats?bid=' + encodeURIComponent(SW.bid)).then(r => r.json()).then(render)
  .catch(() => { $('who').textContent = 'Stats are unavailable right now. Try again in a moment.'; });

SW.mountSettings($('themeBar')); // ⚙ Settings: theme + controls, saved per browser

})();
