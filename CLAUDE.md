# Project notes

> **Reminder for the owner (say this at the start of every session until it's done):**
> Persistent data isn't set up yet. Create a free Postgres database on Neon (neon.tech), copy its
> `postgresql://` connection string, and add it in Render → Environment as `DATABASE_URL`.
> Until then the solo leaderboards (Stackwar lines, Snakewar classic scores) reset on every restart/redeploy. Remove this note once it's done.

Two games share one site and one Node.js server (`server.js`, WebSockets via `ws`), with plain
HTML/CSS/JS clients in `public/`. The homepage has a ‹ › picker (arrow keys too) to choose the game.

- **Stackwar**: multiplayer falling-block battle game (`public/index.html`, `public/game.js`).
- **Snakewar**: battle-royale snake (`snake.js` on the server, `public/snake.html` + `public/snakewar.js`).
- **Blockwar**: block breaker (`public/block.html`, `public/blockwar.js`, `public/block.css`). Single-player
  and client-only for now.

**Every game on this site will eventually be multiplayer** (owner's direction). Build new games and
features with rooms/lobbies in mind, even while a game is single-player.

The homepage lists open lobbies for the selected game under the picker (`GET /api/lobbies`, refreshed
every 3 s; clicking a lobby joins it). Homepage content is anchored near the top so the list can grow
without moving the picker. When a game gets lobbies, add it to `/api/lobbies` in `server.js`.
 Deployed on Render, which auto-deploys from `main`.

## Product decisions
- **Desktop + keyboard only.** Do not spend effort on phone/touch support or mobile layouts.
  Optimize for people at a computer with a keyboard.
- Gamepad/controller support would be welcome later, but it is low priority.
- Boards are 10 wide x 23 tall. The game must fit on screen without scrolling (tested at 1152x720 up to 1920x1080).
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
  that player's cleared lines itself (clients report each clear, capped at 4) and saves their best
  run per username to the leaderboard shown on the homepage (`GET /api/leaderboard`, top 10).
  The homepage leaderboard is **hidden for now** (`SHOW_LEADERBOARD = false` in `public/game.js`) until
  the Neon database is set up; scores are still recorded. Flip it to `true` to show it again.
- **Leaderboard storage** (`leaderboard.js`): Postgres when `DATABASE_URL` is set (required on Render,
  whose filesystem is wiped on every restart/redeploy); otherwise `data/leaderboard.json` for local play.
- **Team mode** (host toggles it in the room panel): each match shuffles players into Red and Blue
  (sizes differ by at most 1, e.g. 3v2). Specials can target anyone, teammates included. Garbage to
  teammates is always just 1 line with a 95% chance of a special; opponents get the normal amount.
  The first 4-line clear gives a bonus special to every living player on that team. A team wins when
  only its players are left. No team score is kept yet.
- The light/dark theme is chosen with the Theme dropdown (System/Dark/Light), saved per browser.

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
  (`snake_leaderboard` table, `GET /api/leaderboard?game=snake`). Not shown on the homepage yet.
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
  20 s), Slow (enemies half speed 5 s; an enemy with Speed just loses it), Extendo (8 s tongue 3 squares
  ahead; enemies whose head touches it die, never hurts you or teammates), Blockade (held: drops 5 tail
  segments as a wall that kills anyone except ghosts; max 5 on the board, a 6th removes the oldest),
  Bomb (held: dropped out of your tail, explodes after 5 s with radius 4, the exact squares shown on the field: destroys food, specials and
  blockades inside, and every snake with any part inside, the bomber included, loses a quarter).
- Held items (Ghost, Blockade, Bomb) go into a 3-slot queue shown on the right; Space uses the oldest.
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
  joins send `game: 'snake'`); they share only `base.css` (theme + base elements) and the `sw-name` /
  `sw-theme` browser storage. Stackwar-only styles go in `style.css`, Snakewar-only in `snake.css`.

## Blockwar
- 800x600 logical board (4:3) scaled to fit under a top bar. A 12x8 grid of touching blocks; 3 lives.
- ←/→ or A/D move the paddle (up/down do nothing yet); Space launches the ball from a centered paddle
  in a random upward direction (within 60° of straight up), and restarts after a win or game over.
- The paddle is drawn flat but bounces like a half circle: the hit point alone decides the new
  direction (center = straight up, ends = 60° out to that side), whatever direction the ball came from.
- Breaking a block bounces off the side it hit; the ball speeds up slightly with each block (max 720 px/s).
  Higher rows score more.

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
