// Solo leaderboards for every game: each player's best score, one spot per player (per browser ID, so a
// new username doesn't earn a second spot), shown under the name they used most recently.
// The board also shows each username only once (ignoring capitals): if the same name has spots from two
// browsers (e.g. the same person on a laptop and a desktop), only its best score is listed and ranked.
//   stackwar: lines cleared in a solo run · snakewar: food eaten in classic solo · blockwar: solo points
const { getPool, jsonFile, playerKey } = require('./db');

const GAMES = ['stackwar', 'snakewar', 'blockwar'];
const TOP_N = 10;

function postgresBoards(pool) {
  const ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS scores (
      game        text NOT NULL,
      player_key  text NOT NULL,
      name        text NOT NULL,
      score       integer NOT NULL,
      achieved_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (game, player_key)
    )`);
    // carry over scores from the old per-username tables (keyed by name; they merge into a browser's
    // spot the first time that name submits from a browser)
    // This copy happens once: the old table is then renamed (kept, not deleted). Re-copying it on every
    // start used to bring back rows that had already merged into a browser's spot, making duplicates.
    for (const [table, game] of [['leaderboard', 'stackwar'], ['snake_leaderboard', 'snakewar']]) {
      const exists = (await pool.query('SELECT to_regclass($1) AS t', [table])).rows[0].t;
      if (!exists) continue;
      await pool.query(
        `INSERT INTO scores (game, player_key, name, score, achieved_at)
         SELECT $1, 'name:' || name_key, name, lines, achieved_at FROM ${table}
         ON CONFLICT DO NOTHING`, [game]);
      await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_migrated`);
    }
    // Clean up leftovers from that old behaviour: a username-keyed row whose player already has a browser
    // spot with the same name and an equal or better score was merged before, so it's a duplicate.
    await pool.query(`DELETE FROM scores s WHERE s.player_key LIKE 'name:%' AND EXISTS (
      SELECT 1 FROM scores b WHERE b.game = s.game AND b.player_key LIKE 'b:%' AND lower(b.name) = lower(s.name) AND b.score >= s.score)`);
  })();
  return {
    async submit(game, key, name, score) {
      await ready;
      const legacy = 'name:' + name.trim().toLowerCase();
      if (key !== legacy) {
        // a score saved under this name before browser IDs existed becomes this browser's
        const old = (await pool.query('DELETE FROM scores WHERE game = $1 AND player_key = $2 RETURNING score, achieved_at', [game, legacy])).rows[0];
        if (old) await pool.query(
          `INSERT INTO scores (game, player_key, name, score, achieved_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (game, player_key) DO UPDATE SET score = GREATEST(scores.score, EXCLUDED.score)`, [game, key, name, old.score, old.achieved_at]);
      }
      const prev = (await pool.query('SELECT score FROM scores WHERE game = $1 AND player_key = $2', [game, key])).rows[0];
      // keep the best score; always show the latest name
      await pool.query(
        `INSERT INTO scores (game, player_key, name, score) VALUES ($1, $2, $3, $4)
         ON CONFLICT (game, player_key) DO UPDATE SET name = EXCLUDED.name,
           score = GREATEST(scores.score, EXCLUDED.score),
           achieved_at = CASE WHEN EXCLUDED.score > scores.score THEN now() ELSE scores.achieved_at END`,
        [game, key, name, score]);
      const best = (await pool.query('SELECT score FROM scores WHERE game = $1 AND player_key = $2', [game, key])).rows[0].score;
      // rank among names: this name's best (from any browser) against every other name's best
      const nameBest = Math.max(best, +(await pool.query('SELECT COALESCE(MAX(score), 0) AS s FROM scores WHERE game = $1 AND lower(name) = lower($2)', [game, name])).rows[0].s);
      const rank = +(await pool.query(`SELECT count(*) + 1 AS r FROM (SELECT lower(name) AS n, MAX(score) AS s FROM scores WHERE game = $1 GROUP BY lower(name)) t
        WHERE t.n <> lower($2) AND t.s > $3`, [game, name, nameBest])).rows[0].r;
      const tenth = (await pool.query(`SELECT s AS score FROM (SELECT MAX(score) AS s, MIN(achieved_at) AS a FROM scores WHERE game = $1 GROUP BY lower(name)) t
        ORDER BY s DESC, a ASC OFFSET $2 LIMIT 1`, [game, TOP_N - 1])).rows[0];
      return { best, rank, prevBest: prev ? prev.score : 0, onBoard: rank <= TOP_N, cutoff: tenth ? tenth.score : 0 };
    },
    async top(game) {
      await ready;
      // one row per username: its best score from any browser
      const { rows } = await pool.query(`SELECT name, score, achieved_at FROM (
          SELECT DISTINCT ON (lower(name)) name, score, achieved_at FROM scores WHERE game = $1 ORDER BY lower(name), score DESC, achieved_at ASC
        ) t ORDER BY score DESC, achieved_at ASC LIMIT $2`, [game, TOP_N]);
      return rows.map(r => ({ name: r.name, score: r.score, at: r.achieved_at }));
    },
  };
}

function fileBoards() {
  const f = jsonFile('scores.json');
  for (const g of GAMES) f.data[g] = f.data[g] || {};
  // one entry per username (best score from any browser), best first
  const sorted = g => {
    const byName = new Map();
    for (const e of Object.values(f.data[g])) { const k = e.name.toLowerCase(), cur = byName.get(k); if (!cur || e.score > cur.score || (e.score === cur.score && e.at < cur.at)) byName.set(k, e); }
    return [...byName.values()].sort((a, b) => b.score - a.score || a.at.localeCompare(b.at));
  };
  return {
    async submit(game, key, name, score) {
      const board = f.data[game], legacy = 'name:' + name.trim().toLowerCase();
      if (key !== legacy && board[legacy]) { const old = board[legacy]; delete board[legacy]; if (!board[key] || board[key].score < old.score) board[key] = { ...old }; }
      const prev = board[key];
      board[key] = !prev || score > prev.score ? { name, score, at: new Date().toISOString() } : { ...prev, name };
      f.save();
      const best = board[key].score, list = sorted(game);
      const nameBest = Math.max(best, ...list.filter(e => e.name.toLowerCase() === name.toLowerCase()).map(e => e.score));
      const rank = list.filter(e => e.name.toLowerCase() !== name.toLowerCase() && e.score > nameBest).length + 1;
      return { best, rank, prevBest: prev ? prev.score : 0, onBoard: rank <= TOP_N, cutoff: list[TOP_N - 1] ? list[TOP_N - 1].score : 0 };
    },
    async top(game) { return sorted(game).slice(0, TOP_N); },
  };
}

const pool = getPool();
const boards = pool ? postgresBoards(pool) : fileBoards();

// submit(game, { bid, name }, score) -> { best, rank, prevBest, onBoard, cutoff }
module.exports = {
  GAMES, TOP_N,
  submit: (game, p, score) => boards.submit(game, playerKey(p.bid, p.name), p.name, score),
  top: game => boards.top(game),
};
