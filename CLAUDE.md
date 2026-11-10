# Project notes

Two games share one site and one Node.js server (`server.js`, WebSockets via `ws`), with plain
HTML/CSS/JS clients in `public/`. The homepage has a ‹ › picker (arrow keys too) to choose the game.

- **Stackwar**: multiplayer falling-block battle game (`public/index.html`, `public/game.js`).
- **Snakewar**: battle-royale snake (`snake.js` on the server, `public/snake.html` + `public/snakewar.js`).
- **Blockwar**: multiplayer block breaker (`block.js` on the server, `public/block.html` + `public/blockwar.js`
  + `public/block.css`).

**Every game on this site will eventually be multiplayer** (owner's direction). Build new games and
features with rooms/lobbies in mind, even while a game is single-player.

The homepage lists open lobbies for the selected game under the picker (`GET /api/lobbies`, refreshed
every 3 s; clicking a lobby joins it). Homepage content is anchored near the top so the list can grow
without moving the picker. When a game gets lobbies, add it to `/api/lobbies` in `server.js`.
Leaving: every game page sends `{t:'leave'}` and closes its socket on Back to lobby and on `pagehide`
(tab closed, reload, browser back); the server drops that connection at once. `server.js` also pings
every connection every 20 s and drops ones that don't answer, so stale players never pile up in lobbies.
New games must call the same `leaveRoom()` pattern.
 Deployed on Render, which auto-deploys from `main`.

## Players, leaderboards and settings
- **Browser ID**: `public/common.js` (loaded by every page) gives each browser a random UUID (`sw-bid` in
  localStorage) and sends it when joining any game. It's how we tell it's the same person across
  username changes (not bulletproof: another browser or cleared site data gets a new ID).
- **Leaderboards** (`leaderboard.js`, table `scores`): one spot per player per game (keyed by browser ID,
  falling back to username), best score kept, shown under the most recent name; top 10 only.
  stackwar = lines in a solo run, snakewar = food in classic solo, blockwar = solo points.
  `GET /api/leaderboard?game=...`. Shown on the homepage next to the lobby list for the selected game
  (`SHOW_LEADERBOARD` in `public/game.js`). The top 3 names tile the homepage background in a moving
  checkerboard (gold/silver/bronze text, each row offset by one name, neighbouring rows drifting opposite ways).
  Old per-username tables (`leaderboard`, `snake_leaderboard`) are copied in on start; such a row merges
  into a browser's spot the first time that name submits from a browser.
- After a solo run the result line says whether it made the leaderboard (`SW.leaderboardText`).
- Sanity checks reject impossible solo scores (Stackwar > ~3 lines/s, Blockwar > ~150 pts/s over the run).
  Stackwar/Blockwar scores still come from the browser, so a determined cheat is possible; Snakewar is
  server-run.
- **Settings** (`settings.js`, table `settings`): one small JSON object per browser ID, `GET/POST
  /api/settings`, max 4 KB. `SW.get/SW.set` keep them in localStorage too and sync to the server.
  Every page has a ⚙ Settings button (`SW.mountSettings`, styles in `base.css`) in place of the old theme
  dropdown, with **Theme** (system/dark/light) and **Controls** (`arrows` | `wasd`). Add future preferences there.
- **Control schemes**: `SW.controls()` is 'arrows', 'wasd', or null (not chosen yet). Stackwar maps keys to
  actions per scheme (arrows: ←/→, ↑/X rotate, Z back, ↓ soft, D discard; WASD: A/D, W/E rotate, Q back,
  S soft, X discard; Space/C/Shift/1-6 in both) and Inverted swaps actions, not keys. Snakewar steers and
  Blockwar moves with the chosen keys; before a player chooses, both sets work there. Help text follows
  the chosen scheme. New games must honor `SW.controls()`.
- Storage: Postgres (Neon) when `DATABASE_URL` is set (`db.js`), else JSON files in `data/` for local play.
  Production's `DATABASE_URL` lives in Render's Environment settings (never commit it).

## Timed specials stack (all games)
- Getting the same timed effect again adds its full duration to what's left instead of restarting it:
  Stackwar Haste/Darkness/Inverted, Snakewar Speed/Ghost/Double/Slow/Extendo, Blockwar Slow/Fast Ball and
  Big/Tiny Paddle. Opposites still cancel/replace (Snakewar Slow cancels Speed; Blockwar Big vs Tiny,
  Slow vs Fast replace each other). Exception: the Snakewar bomb fuse is always 5 s.

## Player stats
- `stats.js` (tables `stats`, `stat_players`): all-time counters and personal bests per player (browser ID)
  per game, recorded by the servers, buffered and written every 5 s. `GET /api/stats?bid=` (also returns
  the player's and everyone's swear jar). Shown on `public/stats.html` (Stats tab at the top of the homepage).
- Stackwar: played/solo/ffa/team games, ffa & team wins, lines, singles/doubles/triples/tetrises, garbage
  sent, first-4-line bonuses, top-outs, specials sent/received/self, best solo.
- Snakewar: games and wins by mode, food (incl. remains/tiny food), longest snake, specials, ghosts/
  blockades/bombs used, bomb hits/bombed, revive tokens/revives, kills (+tongue/blockade kills) and deaths
  by cause. Kill credit: running into a snake's body, or turning into its head, credits that snake;
  tongue credits its owner; a blockade credits whoever placed it; own body/blockade = self-death;
  face-to-face head-on = no credit.
- Blockwar: games and wins by mode, blocks broken and lives lost (running totals sent with board
  snapshots; server counts the increase, capped), specials, best solo score and level.
- New games should record stats the same way and add a card to `statspage.js`.

## Moderation and the swear jar
- `moderation.js`: usernames containing racial slurs are refused at join for every game (checked once in
  `server.js` before routing) and on the homepage (`GET /api/name-ok`). Ordinary swearing is allowed in
  names. Lists are base64-encoded in the file; matching undoes look-alike characters, ignores spacing/
  punctuation and catches stretched letters, while short words only match as whole words. Owner asked
  for slurs only; chat is not filtered.
- Swear jar (`swearjar.js`, table `swear_jar`): any chat message with a swear word adds one quarter and
  the room sees "<name> puts a quarter into the swear jar. The swear jar is at $X.XX." Kept permanently,
  per player (browser ID), so per-player totals can be shown later.

## Product decisions
- **Desktop + keyboard only.** Do not spend effort on phone/touch support or mobile layouts.
  Optimize for people at a computer with a keyboard.
- Gamepad/controller support would be welcome later, but it is low priority.
- Boards are 10 wide x 23 tall. The game must fit on screen without scrolling (tested at 1152x720 up to 1920x1080).
- Stackwar game screen uses Blockwar's layout: top bar (Back to lobby, title + room, Lines/Level,
  ⚙ Settings moved into the bar), then players/chat/Controls & specials on the left, your name + specials
  hand above Saved/Next and your centered board, and opponent boards (3 columns, sized by window height
  and width) on the right. The homepage no longer has the Controls & specials box.
- Every player gets the same piece queue (shared seed from the server).
- Players can save one piece (C or Shift). Bringing it back swaps it with the current piece; allowed once per piece.
- Clearing 2/3/4 lines sends 1/2/3 garbage lines to every other living player.
  Exception: the first 4-line clear of each match sends 4 and gives that player a free random special
  (never Add Line, Clear Line, Darkness or Haste).
- Specials are fired at one chosen player by pressing that player's number (1–6). Numbers are
  per viewer: you are always 1 on your own screen (so 1 = yourself), others are 2+ in join order.
  Never apply a special to all players at once.
- Specials hand is shown in the header right above your board (leftmost fires next). It holds 5; collecting more drops the oldest (next-to-fire) ones. Clearing 3+ lines
  at once collects each special in those lines twice.
- Specials: A Add Line, C Clear Line, R Random Clear (8 blocks), Q Earthquake, G Gravity, B Blank (3 specials), H Haste,
  D Darkness (target board blacked out ~4s), I Inverted (target's controls scrambled 5s: left/right,
  rotations and up/down swap; hard drop unchanged), S Switch, N Nuke. N/G/S are rarer than the rest.
- **Solo runs:** a game started with only one player in the room is a solo run. The server counts
  that player's cleared lines itself (clients report each clear, capped at 4) and records the run.
- **Team mode** (host toggles it in the room panel): each match shuffles players into Red and Blue
  (sizes differ by at most 1, e.g. 3v2). Specials can target anyone, teammates included. Garbage to
  teammates is always just 1 line with a 95% chance of a special; opponents get the normal amount.
  The first 4-line clear gives a bonus special to every living player on that team. A team wins when
  only its players are left. No team score is kept yet.

## Snakewar
- Server-authoritative: `snake.js` moves every snake each tick (110 ms), resolves collisions and food,
  and broadcasts the whole field. Clients only send direction changes / item use and draw.
- Layout: left column (Back to lobby, scoreboard, mode buttons, revive tokens, chat), right column
  (theme, help, held items as big icons), top center (team revives, shrink warning). The field sizes
  itself into the space between (`PAD` in `public/snakewar.js` must match `snake.css`).
- One shared 16:9 field. Its size depends on the players in the room when the round starts:
  2 players 56x32 (quarter area), 3 players 79x45 (half), 4+ 112x63 (full). Up to 12 per room;
  lobby code defaults to `lobby` (rooms are separate from Stackwar's).
- **Solo is classic snake**: 32x18 board, solid walls (no wrap), one food at a time, +1 per food, no
  special foods, no shrinking. Score = food eaten; best per username goes to `leaderboard.snake`
  (`GET /api/leaderboard?game=snakewar`).
- Battle rounds (2+ players) wrap at the play-area edge. Any snake body or blockade kills; a dead snake
  leaves food on every other segment. Head contests: face to face both die; if one turned into the
  other's head from the side, only the turner dies; running into the side of a head kills the mover.
- Food: regular food and dead-snake drops +2, "tiny food" (cut tails) +1. Regular food starts at one per
  player and rises through the round (x2 after 1 min, x3 after 2 min, max x5 / 100).
- **Shrinking board**: 10 s warning (new edge shown in red) starts 2 min in or 3 s after a death (team rounds:
  4 min in, or 3 s after a team of 2+ is down to its last snake); each
  shrink keeps the middle ~80% (min 24x14), then the next warning comes 30 s later or 3 s after a death.
  A snake loses everything from its first segment outside the new edge to its tail (that cut part's
  inside cells become tiny food); a snake whose head is outside dies.
- Food and special foods spawn slightly more often toward the middle (half even, half centre-weighted).
- Special foods (max 3, vanish after 15 s): Speed (2 steps/tick 5 s; also clears Slow), Ghost (held: 6 s
  through snakes and blockades, immune to other players' Shears/Slow/Bomb/Extendo), Feast (worth +5, +5
  more per minute played when it appears; grows +1 every 3 s; never vanishes; max 2, outside the 3-cap), Shears (enemies lose 1/4 of their length, min 3; cut tail -> tiny food), Double (growth x2
  20 s), Slow (enemies half speed 5 s; an enemy with Speed just loses it), Extendo (12 s tongue 5 squares
  ahead; enemies whose head touches it die, never hurts you or teammates; it also eats food, remains and
  tiny food it touches, not special items), Blockade (held: drops 5 tail
  segments as a wall that kills anyone except ghosts; max 5 on the board, a 6th removes the oldest),
  Bomb (held: dropped out of your tail, explodes after 5 s with radius 5, the exact squares shown on the field: destroys food, specials and
  blockades inside, and every snake with any part inside, the bomber included, loses a quarter).
- Held items (Ghost, Blockade, Bomb) go into a 3-slot queue shown on the right; Space uses the oldest.
- Snake heads are drawn slightly darker than the body (`darker()` in `public/snakewar.js`) so heads are easy to spot.
- Colors: while not in play (between rounds, dead, spectating) players use ‹ › by their name on the
  scoreboard: any of 12 colors normally, or one of 6 shades of their team's color in team mode.
- **Team mode** (host toggle between rounds): random Red vs Blue each round; Red spawns on the left facing
  right, Blue on the right facing left (revives too). Red team = warm shades,
  blue team = cool shades, plus a team-colored ring on each head. Shears/Slow/Extendo hit the other team
  only. Revive tokens spawn only in team rounds, rarer as the round goes on; every 3 a team collects =
  1 revive, used automatically to respawn a dead teammate. Team out = nobody alive. No team score yet.
- Chat/log is hidden from players who are alive in a round (Enter opens it); it shows for
  spectators, eliminated players, and between rounds. It auto-scrolls unless you scrolled up.
- **The two games must stay isolated.** Each connection belongs to one game for its life (Snakewar
  joins send `game: 'snake'`); they share only `base.css` (theme + base elements), `common.js` (browser ID +
  settings), the homepage/stats tabs and the `sw-name` / `sw-theme` / `sw-bid` / `sw-settings` browser storage. Stackwar-only styles go in `style.css`, Snakewar-only in `snake.css`.

## Blockwar
- Like Stackwar: each player's game runs in their own browser; `block.js` handles rooms, the host's mode
  choice, starts matches (one shared seed), relays board snapshots (~4/s) and specials, and decides winners.
- Layout: room panel + chat on the left, your board centered with your 3-slot special queue above it,
  other players' boards (half size) on the right. Numbers are per viewer like Stackwar (1 = you).
- 800x600 logical board, 12 columns x 18 rows of space, starting with 8 touching rows; ←/→ or A/D move,
  up/down do nothing yet; Space launches from a centered paddle (host: Space also starts a match).
- Paddle bounces like a half circle: the hit point alone decides the new direction (center = straight up,
  ends = 60° to that side). Blocks bounce off the side hit; the ball speeds up a little per block.
- Losing your last ball costs a life (Multiball: only when every ball is gone), then a 5 s wait before
  the ball is back on a centered paddle.
- Modes: **solo** (1 player): endless; each row's worth of blocks broken brings a new row in at the top,
  level up every 5 rows (+8% ball speed each); over when blocks reach the bottom row or lives run out.
  **Clear race**: identical boards, first to clear every block wins, unlimited lives (misses just cost
  the 5 s wait). **Lives**: 3 lives, a cleared board refills, last player with lives left wins.
  Team mode is planned. Solo will later get random artifacts/shapes at higher stages.
- Specials: ~7% of blocks carry a letter; breaking one adds it to your queue (max 3, oldest dropped);
  1-6 fires it at that player (1 = you), X discards, or click a board. R Random (stone boulder or
  stalactite), C Clear Line (lowest row), M Multiball (doubles balls), S Slow Ball / F Fast Ball (half /
  double speed 10 s), B Big Paddle / T Tiny Paddle (double / half width 10 s), Q Earthquake (shuffles
  the board, buries specials away from the exposed edge).

## Roadmap (from the owner)
**Planned**
- **Better chat room.** A basic chat already exists in the Log panel (typing there broadcasts to the
  room). Upgrade it into a proper chat for trash talk during games: its own panel, separate from
  game events, readable while playing.
- **Per-user settings** the player controls: theme, key bindings, soft-drop speed, and left/right
  auto-repeat (delay before repeating + repeat speed when holding a direction). Today the theme is
  saved per browser only. Tie settings to the username/account rather than IP addresses (IPs are
  shared on home networks and change often).

**Tentative**
- **Claimed usernames with a password**, so nobody else can play under a name someone has claimed.
  Needs persistent storage on the server (Render's free plan has no persistent disk, so this means a
  hosted database), with passwords stored as hashes.

**Later / low priority**
- Gamepad/controller support.
