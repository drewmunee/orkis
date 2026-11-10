# Project notes

> **Reminder for the owner (say this at the start of every session until it's done):**
> Persistent data isn't set up yet. Create a free Postgres database on Neon (neon.tech), copy its
> `postgresql://` connection string, and add it in Render → Environment as `DATABASE_URL`.
> Until then the solo leaderboard resets on every restart/redeploy. Remove this note once it's done.

Two games share one site and one Node.js server (`server.js`, WebSockets via `ws`), with plain
HTML/CSS/JS clients in `public/`. The homepage has a ‹ › picker (arrow keys too) to choose the game.

- **Stackwar**: multiplayer falling-block battle game (`public/index.html`, `public/game.js`).
- **Snakewar**: battle-royale snake (`snake.js` on the server, `public/snake.html` + `public/snakewar.js`).
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
  D Darkness (target board blacked out ~4s), S Switch, N Nuke. N/G/S are rarer than the rest.
- **Solo runs:** a game started with only one player in the room is a solo run. The server counts
  that player's cleared lines itself (clients report each clear, capped at 4) and saves their best
  run per username to the leaderboard shown on the homepage (`GET /api/leaderboard`, top 10).
- **Leaderboard storage** (`leaderboard.js`): Postgres when `DATABASE_URL` is set (required on Render,
  whose filesystem is wiped on every restart/redeploy); otherwise `data/leaderboard.json` for local play.
- The light/dark theme is chosen with the Theme dropdown (System/Dark/Light), saved per browser.

## Snakewar
- Server-authoritative: `snake.js` moves every snake each tick (110 ms), resolves collisions and food,
  and broadcasts the whole field. Clients only send direction changes and draw.
- One shared 112x63 (16:9) field scaled to fill the window. Up to 12 players per room; lobby code
  defaults to `lobby` (rooms are separate from Stackwar's).
- The field wraps at every edge. Any snake body (including your own) kills; head-on collisions kill both. A dead snake
  leaves food on every other segment. Last snake alive wins (solo: play until you die).
- Always one regular food per player in the round. Special foods spawn randomly (max 3, vanish
  after 15 s): Speed (2 steps/tick for 5 s), Ghost (pass through snakes for 6 s), Feast (+5 length),
  Shears (every other snake loses 4 segments, never below 3).
  Owner said more special abilities are TBD.
- Chat/log is hidden from players who are alive in a round (Enter opens it); it shows for
  spectators, eliminated players, and between rounds.
- **The two games must stay isolated.** Each connection belongs to one game for its life (Snakewar
  joins send `game: 'snake'`); they share only `base.css` (theme + base elements) and the `sw-name` /
  `sw-theme` browser storage. Stackwar-only styles go in `style.css`, Snakewar-only in `snake.css`.

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
