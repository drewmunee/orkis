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
  checkerboard (gold/silver/bronze text, bronze darkened to #8a5222, each row offset by one name, neighbouring rows drifting opposite ways).
  The board lists each username once (case-insensitive): if a name has spots from several browsers, only
  its best is shown and ranked (rank/cutoff are per name too).
  Old per-username tables (`leaderboard`, `snake_leaderboard`) are copied in once, then renamed to
  `*_migrated` (re-copying on every start used to resurrect merged rows as duplicates); a 'name:' row
  merges into a browser's spot the first time that name submits from a browser. On start, 'name:' rows
  duplicated by a browser spot with the same name and an equal or better score are deleted.
- **Duplicate names**: no two players in the same lobby (any game) may share a name, ignoring case
  (`moderation.nameClash`); the same browser ID rejoining replaces its old connection instead. The
  homepage pre-checks this via `GET /api/name-ok?name=&room=&game=&bid=`. Names aren't owned site-wide
  until claimed usernames (roadmap) exist.
- After a solo run the result line says whether it made the leaderboard (`SW.leaderboardText`).
- Sanity checks reject impossible solo scores (Stackwar > ~3 lines/s, Blockwar > ~150 pts/s over the run).
  Stackwar/Blockwar scores still come from the browser, so a determined cheat is possible; Snakewar is
  server-run.
- **Settings** (`settings.js`, table `settings`): one small JSON object per browser ID, `GET/POST
  /api/settings`, max 4 KB. `SW.get/SW.set` keep them in localStorage too and sync to the server.
  Every page has a ⚙ Settings button (`SW.mountSettings`, styles in `base.css`) in place of the old theme
  dropdown, with **Theme** (system/dark/light), **Controls** (`arrows` | `wasd`), **Snakewar steering** and **Avatar**. Add future preferences there.
- **Control schemes**: `SW.controls()` is 'arrows', 'wasd', or null (not chosen yet). Stackwar maps keys to
  actions per scheme (arrows: ←/→, ↑/X rotate, Z back, ↓ soft, D discard; WASD: A/D, W/E rotate, Q back,
  S soft, X discard; Space/C/Shift/1-6 in both) and Inverted swaps actions, not keys. Snakewar steers and
  Blockwar moves with the chosen keys; before a player chooses, both sets work there. Help text follows
  the chosen scheme. New games must honor `SW.controls()`.
- **Snakewar steering** (setting `snakeKeys`: `normal` | `nokia` | `vim`, `SW.snakeKeys()`): two-key relative
  steering on top of the normal keys. NOKIA = the numeric keypad's 1 / 9 only, never the top-row digits
  (`e.code` Numpad1/9, or keypad `e.location` 3 reporting End/PageUp with Num Lock off), VIM = H / L. Moving sideways, key 1/H
  turns up and 9/L turns down; moving up or down, 1/H turns left and 9/L turns right. The client sends
  `{t:'dir', rel:'a'|'b'}` and `snake.js` resolves it against the last queued direction.
- **Avatars** (setting `avatar`): one of the Snakewar item emojis (`SW.AVATARS` in `common.js`, same list in
  `avatars.js` on the server, which drops anything else). Sent on join and live via `{t:'avatar', a}`;
  every game's `playerList` carries `avatar`, and clients show `SW.avatarHtml(p)` before names in the player
  list, your name bar, opponent boards and chat. Not shown on homepage leaderboards/chat yet.
- Storage: Postgres (Neon) when `DATABASE_URL` is set (`db.js`), else JSON files in `data/` for local play.
  Production's `DATABASE_URL` lives in Render's Environment settings (never commit it).

## Database safety (owner's requirement: a deploy must never lose or duplicate stored data)
- **All schema changes go in `migrations.js`** as a new numbered entry at the end. Modules never create
  or alter tables themselves; they `await ready()` from `db.js`. Never edit, reorder or delete a shipped
  migration. Each runs once (recorded in `schema_migrations`) in a transaction, under an advisory lock
  (Render runs old + new servers side by side during a deploy). If one fails, `server.js` exits before
  listening, so Render keeps the previous version live.
- Additive changes only: new tables, `ADD COLUMN ... DEFAULT`, indexes. Never rename/drop tables or
  columns with data, and never rename stored keys (game ids like `stackwar`, stat names, `player_key`
  formats `b:<bid>` / `name:<name>`); add new ones and read both. The runner refuses DROP/TRUNCATE and
  DELETE/UPDATE without WHERE unless the migration is marked `destructive: true` (needs the owner's OK).
  Row copies must be repeat-safe (`ON CONFLICT DO NOTHING`, `GREATEST`).
- Before new migrations run, every table is copied to schema `backup_before_<id>` (newest 3 kept).
- Writes that touch several rows use `transaction()`. Stats batches are all-or-nothing and re-queued on
  failure (never double-counted or dropped); on SIGTERM the server closes sockets (solo runs record),
  flushes stats and exits.
- New stats: just call `stats.add`/`stats.best` with a new stat name; no migration needed.
- **Before shipping any storage change, run** `TEST_DATABASE_URL=postgres://sw:sw@localhost/sw npm run test:db`
  (local scratch DB only; it wipes it) and add a check for the new data to `scripts/db-safety-test.js`.

## Timed specials stack (all games)
- Getting the same timed effect again adds its full duration to what's left instead of restarting it:
  Stackwar Haste/Darkness/Inverted, Snakewar Speed/Ghost/Double/Slow/Extendo, Blockwar Slow/Fast Ball,
  Big/Tiny Paddle and Explosivo. Opposites still cancel/replace (Snakewar Slow cancels Speed; Blockwar Big vs Tiny,
  Slow vs Fast replace each other). Exception: the Snakewar bomb fuse is always 3 s.
- Timed effects shown as pills blink (every 250 ms) in their last 3 s: Blockwar's pills (on the board,
  top right, above the blocks) and Stackwar's Haste/Inverted pills (`#fx` beside the specials hand).
  Darkness deliberately has no pill. Blockwar Big Paddle also fades in and out in its last 3 s.
  Snakewar shows no effect timers yet.

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

## Homepage chat and Stackwar daily run
- **Homepage chat** (`homechat.js`, table `home_chat`): one site-wide room, fixed in the homepage's
  bottom-left corner; keeps only its newest 50 lines. `GET /api/chat?after=<id>` (polled every 3 s while
  the homepage shows), `POST /api/chat {bid, name, msg}`. Uses the username box above; slur names refused,
  1 message/s per player, `/commands` refused (they work in game lobbies), swear jar applies (its line is
  saved as a nameless event line). Below 1700 px wide the homepage tables shift right of the chat
  (`#boards` padding) and below 1380 px they slim down, so nothing overlaps at 1152x720.
- **Daily run** (`daily.js`, table `daily_runs`): Stackwar only, shown right of the leaderboard. Each UTC
  day has one seed (`seedFor(day)`); "Play today's run" joins a private hidden room (`daily-…`, not in
  `/api/lobbies`, nobody else can join) that starts at once. Goal: 40 lines; no garbage, no first-4-line
  bonus, team mode off. The server times it from the end of the 3 s countdown to the clear reaching 40
  (under 12 s is rejected), keeps each player's best per day (one entry per username on the board, top 10),
  and doesn't touch the normal solo leaderboard. Topping out just ends the attempt; "Play again" retries, and
  **R** restarts instantly at any time, even mid-run (`{t:'restart'}`, daily rooms only; same seed, new
  attempt, 3 s countdown; once R is used, no run in that session can get the ⚡ badge).
  The client shows the live timer under Level (`#timeStat`, daily runs only; it holds the final time) and x/40 in the status line. `GET /api/daily` -> {day, goal, resetsInMs, top, hall}.
  Under the daily top 10, a hall of fame (`daily.hall`): the 3 names with the most daily wins (finished
  days; ties on a day all count, same as placings) and the single fastest time ever (any day, today
  included). To fit at 1152x720 the daily list scrolls inside its box when short of room, and windows
  under 800 px tall get less space above the picker.
  Stats: `daily_runs`, `daily_finishes`, plus `daily_wins` / `daily_podiums` (1st / top 3 on finished days,
  worked out from `daily_runs` by `daily.placings` when `/api/stats` is read; shown in the Stackwar card). Every run started counts as an attempt (`daily_attempts`, topped-out
  and quit runs too); a best time set on attempt 1 shows a ⚡ on the board (`first_try`), and a better time
  from a later attempt replaces it without the badge (a slower later run keeps it).

## Chat commands (all games)
- `commands.js`, shared by all three games' chat handlers: a chat message starting with `/` is a command,
  not chat (never broadcast, no swear jar). One word, case-insensitive, extra words ignored. Replies go
  only to the sender as log lines. Same commands everywhere; results depend on the game/room.
- `/host N` (`/host 2` or `/host two`; numbers as in the player list, 1 = you, others by join slot): the host
  hands the host role to another person (never a bot); games pass `ctx.setHost`. Commands get their extra
  words as `args`. The host can also click another person's number (Snakewar: name) in the player list
  (`{t:'sethost', id}`). In every player list the 👑 sits in a fixed slot left of the number/colour.
- `/help` (also `/list`, `/?`, or just `/`) lists them all; `/podium`: top 3 players in this lobby by wins this
  session (room wins, reset on rejoin); `/leaderboard`: top 3 people in this lobby by all-time wins in this
  game (sum of their `wins_*` stats; commands may return a Promise); `/spectate` (Stackwar and Snakewar: sit out / rejoin; games pass an optional `ctx.spectate` hook; Blockwar says it isn't available yet). Add new commands to `COMMANDS` (use `alias` for alternate names).

## Moderation and the swear jar
- `moderation.js`: usernames containing racial slurs are refused at join for every game (checked once in
  `server.js` before routing) and on the homepage (`GET /api/name-ok`). Ordinary swearing is allowed in
  names. Lists are base64-encoded in the file; matching undoes look-alike characters, ignores spacing/
  punctuation and catches stretched letters, while short words only match as whole words. Owner asked
  for slurs only; chat is not filtered.
- Swear jar (`swearjar.js`, table `swear_jar`): any chat message with a swear word always adds one quarter;
  the room sees "<name> puts a quarter into the swear jar. The swear jar is at $X.XX." only on that player's
  1st quarter and every 3rd after (1st, 4th, 7th ... by their saved count; `addQuarter` resolves to null
  for the quiet ones, and callers skip null). Kept permanently,
  per player (browser ID), so per-player totals can be shown later.

## Product decisions
- **Desktop + keyboard only.** Do not spend effort on phone/touch support or mobile layouts.
  Optimize for people at a computer with a keyboard.
- Gamepad/controller support would be welcome later, but it is low priority.
- Boards are 10 wide x 23 tall. The game must fit on screen without scrolling (tested at 1152x720 up to 1920x1080).
- Stackwar game screen uses Blockwar's layout: top bar (Back to lobby, title + room, ⚙ Settings moved
  into the bar), then players/chat/Controls & specials on the left (300 px wide), your name + specials hand above
  Next, then Saved underneath it (with Lines and Level floating below) and your centered board, and opponent boards (3 columns, sized by window height
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
  rotations and up/down swap; hard drop unchanged; on the target's own screen every piece colour 1-7 is
  swapped for another for as long as it lasts (`invertColors`, board/falling piece/Next/Saved; opponent boards and
  garbage keep their colours)), S Switch, N Nuke. N/G/S are rarer than the rest.
- **Bots** (`stackbot.js`): the host adds them between games from the room panel (**＋ Easy / ＋ Medium /
  ＋ Insane** under the player list, `{t:'addbot', level}`); whoever is host can remove one at any time,
  mid-game too (×, `{t:'removebot', id}`; mid-game it counts as out); never in daily runs; up to the 6-player
  limit. Once no people are left playing, the host gets **End game** (`endBtn`, `{t:'endgame'}`; no winner).
  A win only goes into a person's stats (`winCounts`) if their opponents in that game included another
  person or an insane bot (beating only easy/medium bots still shows ★ in the room but isn't recorded). Each bot connects through a fake socket (`BotSocket`, `ws.isBot`, so a
  browser can't pose as one) and joins/plays with the exact same messages as a browser, so garbage, specials,
  Switch, teams and winners work unchanged; it keeps its own board with the same rules and shared piece
  queue as `public/game.js` (keep the two in sync). Bots never get stats; the room closes when no people are
  left; the host is always a person. Placement: try every rotation/column (with hold for medium/insane),
  score with a Dellacherie-style evaluation; tetris builders (medium, insane) keep a well column and only take
  smaller clears under pressure. Every bot gets its own style (`makeStyle`: weights nudged ±25%, well on the
  left or right, its own survive-mode threshold and tetris appetite) and picks among near-best spots
  (softmax with a per-bot temperature) on top of its difficulty's mistakes, so no two bots play alike. Easy: ~3 s per piece, 25% next-best / 3% random
  spots, likes singles/doubles with occasional building streaks, fires specials at random players every
  3-8 s (harmful ones, Random Clear included, never at itself). Medium: ~1.5 s, 7% slips, helpful specials (C/N/G) on itself and the rest on a random opponent at
  once. Insane: usually ~1 s per piece, often 0.75 s (60/40), 5% slips, saves C/N/G for emergencies (or a full
  hand), Switch only to steal a much better board, finishes off players near the top, otherwise hits the biggest
  threat: other insane bots first in most cases, then people, then medium/easy bots, scaled by how well they're
  doing, with some randomness (Blank: whoever has the most specials). Bots target bots and people alike. Insane bots never take the first-tetris bonus
  (their 4-line clear sends the normal 3 and leaves the bonus up for people and easy/medium bots). A bot slower than the falling piece only gets part of its move done (so only insane
  copes at high levels); Haste speeds their pieces up. Darkness: they plan on the board they remember from
  when it went dark (`darkBoard`; later garbage is invisible) and slip up much more, at every difficulty.
  Inverted: easy/medium pick per inversion to freeze (pieces just fall from spawn) or flail (random spots);
  insane botches one piece (mirrored), then plays carefully at ~2.4 s per piece until it wears off.
  Insane bots also slow to ~1.9 s per piece while Darkness is on them.
  **Team mode**: bots never aim bad specials at teammates (easy: 75% of the time it sends good ones to its own
  side and bad ones to the other team, otherwise anyone) and only Switch with / Blank / finish off opponents.
  Medium and insane rescue a teammate whose stack is 14+ and taller than their own with C/N/G (G only if
  it has 3+ holes): decided once per teammate in trouble for 4 s (`this.rescue`), yes 60% (medium) / 85%
  (insane). Random Clear is treated as an attack by every bot (never fired at itself). Insane also passes spare C/G (or anything from a full hand) to the teammate with the tallest
  stack when it's 3+ rows taller than its own.
- **/spectate** (chat command) also works in Stackwar: spectators sit out the next games (not in
  `startCount`, teams, stats or `startedWith`; their own game doesn't start, they just watch the boards) and
  show a grey 👁; one player + spectators is a solo run; everyone spectating = no start; not in daily runs.
  Their board shows a big 👁 over it on everyone's screen.
- **Watchers** (Stackwar): joining a full room (6 seats) makes you a watcher (`room.watchers`, `me.watcher`,
  welcome `watcher:true`; full daily rooms still refuse). Watchers get broadcasts and chat but no seat; they're
  listed in the top bar ("👁 Watching: …", `#watchers`, `lobby.watchers`) and the homepage lobby row
  (`N 👁`, "full (join to watch)"). Their screen hides the main board (`#game.watching`) and shows all
  6 playing boards as big as fits: `fitWatch()` in `game.js` tries every column count (1 row of 6, 2 of 3, ...)
  and picks the biggest boards that fit top to bottom (canvases drawn at 30 px/cell there). A watcher can **Take over** a bot (`{t:'takebot', id}`: the bot leaves, the watcher
  takes its slot and plays from the next game) or **Take a seat** when one is free (`{t:'sit'}`). If the
  last seated person leaves, the first watcher is seated (and becomes host).
- Log lines for specials show the special's name as a pill in its block colour (`log(msg, special)`).
- Only 4-line clears are announced in the chat/log; 2- and 3-line clears still send garbage silently.
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
- **Solo is classic snake**: 32x18 board, solid walls (no wrap), +1 per food, no special foods, no
  shrinking. Starts with one food on the board; every 30 eaten adds one more (max 3), and every 45 eaten
  speeds the game up 1.25x (compounding, tick never under 30 ms; the server restarts its tick timer and
  logs "Speed up!"). Score = food eaten; best per username goes to `leaderboard.snake`
  (`GET /api/leaderboard?game=snakewar`).
- Battle rounds (2+ players) wrap at the play-area edge. Any snake body or blockade kills; a dead snake
  leaves food on every other segment. Head contests: face to face both die; if one turned into the
  other's head from the side, only the turner dies; running into the side of a head kills the mover.
- Food: regular food and dead-snake drops +2, "tiny food" (cut tails) +1. Regular food starts at one per
  player and rises through the round (x2 after 1 min, x3 after 2 min, max x5 / 100).
- **Shrinking board**: 10 s warning (new edge shown in red) starts 2 min in or 3 s after a death (team rounds:
  also 2 min in, or 3 s after a team of 2+ is down to its last snake); each
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
  Bomb (held: dropped out of your tail, explodes after 3 s with radius 5; the exact squares are shown only
  to the player who dropped it (state bombs carry the owner id), everyone else sees just the bomb and fuse: destroys food, specials and
  blockades inside, and every snake with any part inside, the bomber included, loses a quarter).
  Pacman (held: 6 s sliding through enemy snakes; each enemy square you pass through is -1 length for them
  (taken off their tail end so the body stays whole, never below 3) and +1 for you; heads and ghosts can't
  be bitten; teammates, your own body and blockades still
  kill; icon is a CSS/canvas shape, not a font glyph), Poop (held: 6 s of slime on the square your tail
  sits on, each lasting 8 s; an enemy head on slime loses Speed and is slowed 1.5 s; never you/your team,
  not ghosts), Stone (held: 5 s frozen in place; immune to everything except the shrinking board; any snake
  that runs into it dies, ghosts and Pacman included; drawn grey and cracked; stats stone_used/stone_kills).
  `immune(p)` (ghost, stone or revive shield) is the one check for "safe from other players' items".
- **Bonus tiles** (battle rounds only, own spawner: ~1 per 4 s, max 4 on the field, 20 s each; never in the
  special pool). The host picks the kind in the lobby (`tilesBtn`, `{t:'tiles', mode}`, `room.tileMode`,
  fixed per round as `room.roundTiles`): **fruit** (default: 🍌 🍒 🍊; collect any fruit, counted per kind;
  every 3rd of a kind resets that count and pays its own reward: banana = +12 length, cherry = every enemy
  loses a third, orange = 2 random special items applied as if picked up), **letters** (weighted bag, no J/Q/X/Z; 4-letter rack, a 5th
  drops the oldest; 4 that can be arranged into a word from `words4.js` (5,466 words from the MIT
  `word-list` package, slurs removed) pay out and clear the rack) or **none**. The payout (`tileBonus`) is a
  coin flip for words: +12 length (x2 with Double) or every enemy loses a third (min 3, immune snakes safe). Fruit counts /
  letter rack shown under the items. Tiles live in `room.letters` ({ch} or {fruit}). Fruit emoji must be
  drawn with an opaque fillStyle (canvas applies its alpha to emoji). Stats: letters, words, fruit,
  fruit_sets, pacman_used/bites/bitten, poop_used.
- **Bots** (`snakebot.js`, wired in `snake.js`): the host adds them between rounds with **＋ Add bot** under
  the player list (`{t:'addbot'}`); whoever is host can remove one at any time with × (`{t:'removebot', id}`;
  mid-round it dies as "was removed"); up to the 12-player limit, named
  "Bot Rex" etc., shown with 🤖. They're players with a stub socket (`bot: true`), so 1 person + bots is a
  normal battle round (never classic), and they fill teams like unpicked players. Never get stats
  (`stats.js` skips `p.bot`) or leaderboard scores; their kills don't credit them; they can win rounds
  (room ★ wins / `/podium`). The room closes when no people are left; the host is always a person.
  Bots play like people, not machines: they see other snakes as they were 2 ticks ago (`REACTION_TICKS`,
  plus each seen head projected forward along its direction, like anticipating it), so they can't dodge
  within a single square; they decide every 1-2 ticks and never turn twice in a row (no perfect
  staircase), unless they see a crash up to 2 squares ahead; they take L-shaped routes (straight until
  lined up with the target, then turn), following the BFS route instead when the L is blocked; a target
  they get no closer to for ~1 s (`STALE_TICKS`, e.g. two bots side by side) is banned for 5 s; with nothing
  to chase, or after a long straight run, they wander toward open space. Each decision: rule out crashing moves,
  score the rest by open space (capped flood fill), head-on risk (any other head, teammates too),
  bomb/shrink danger, the L-route and the BFS first step toward the best target (food, specials, tokens,
  fruit/letters, inside the shrink edge, enemy bodies while Pacman, or 3 squares ahead of a smaller
  enemy's head while "hunting", which each bot does now and then based on its own aggression).
  **Frenzy**: once every person in the round is dead/spectating, bots hunt anyone within reach every few
  seconds. Items: Ghost/Stone when trapped, Blockade/Poop when an enemy is behind, Bomb when enemies are
  near the tail, Pacman near enemy bodies, anything after holding a full hand 12 s.
  Once no people are alive, the host gets **End round** (`endBtn`, `{t:'endround'}`; no winner).
  Tested with simulated rounds (~60-75 s with a person alive, ~1 min bot-only frenzy, ~14 food per bot-minute vs ~20 for the old perfect bots, side-by-side bots split up in ~0.6 s, ~12-20 ms worst tick).
- **/spectate** (chat command; Snakewar only, other games reply that it isn't available): toggles sitting out.
  Spectators are left out of the next rounds (field size, solo/classic and teams count only players), shown
  with a grey 👁 by their name. If everyone is spectating, the round doesn't start.
- Held items (Ghost, Blockade, Bomb, Pacman, Poop) go into a 3-slot queue shown on the right; Space uses the oldest.
- Snake heads are drawn slightly darker than the body (`darker()` in `public/snakewar.js`) so heads are easy to spot.
- Colors: while not in play (between rounds, dead, spectating) players use ‹ › by their name on the
  scoreboard: any of 12 colors normally, or one of 6 shades of their team's color in team mode.
- **Team mode** (host toggle between rounds): Red vs Blue each round. The host also picks **random teams**
  (default; shuffled and split evenly) or **players choose** (`teamChoiceBtn`, `{t:'teamchoice'}`,
  `room.teamChoice`). Players set a preferred team shade (0-5, same shade on red or blue) in ⚙ Settings
  (`teamShade`, sent on join and as `{t:'shade', i}`). In choose mode, between rounds, the ‹ ›
  color picker cycles 6 red shades then 6 blue shades, which sets `teamPick` (shown as R/B in the lobby);
  otherwise it only changes the shade. `assignTeams` honours picks (choose mode), puts unpicked players on the smaller team, and only if a team would be
  empty moves random players over until the sizes differ by at most 1 (so picks can make e.g. 3v1). Red spawns on the left facing
  right, Blue on the right facing left (revives too). Red team = warm shades,
  blue team = cool shades, plus a team-colored ring on each head. Shears/Slow/Extendo hit the other team
  only. Revive tokens spawn only in team rounds, rarer as the round goes on; every 3 a team collects =
  1 revive, used automatically to respawn a dead teammate. Both teams' token progress (●●○) shows beside
  their revive counts in the top bar, visible to everyone. After any death in a team round, tokens spawn
  4x as often for 20 s. A revived snake blinks in place for 3 s (`spawnUntil`: not moving, nothing can hit
  it, others pass through), then has 3 s of `fx.shield` (passes through like a ghost, immune to items,
  pulsing white ring). Team out = nobody alive. No team score yet.
- Chat/log is hidden from players who are alive in a round (T opens it; in every game T opens chat and
  Enter sends); it shows for
  spectators, eliminated players, and between rounds. It auto-scrolls unless you scrolled up.
- **Every chat/log on the site** (all three games' logs and the homepage chat) appends through
  `SW.stickyScroll(el)` in `common.js`: it stays pinned to the bottom (also on resize) unless the user has
  scrolled up, and resumes once they scroll back down. New chats must use it.
- **The two games must stay isolated.** Each connection belongs to one game for its life (Snakewar
  joins send `game: 'snake'`); they share only `base.css` (theme + base elements), `common.js` (browser ID +
  settings), the homepage/stats tabs and the `sw-name` / `sw-theme` / `sw-bid` / `sw-settings` browser storage. Stackwar-only styles go in `style.css`, Snakewar-only in `snake.css`.

## Blockwar
- Like Stackwar: each player's game runs in their own browser; `block.js` handles rooms, the host's mode
  choice, starts matches (one shared seed), relays board snapshots (~4/s) and specials, and decides winners.
- Layout: room panel + chat on the left, your board centered with a bar above it (your name, then
  Lives/Score/Blocks (+Level in solo) in the middle, then your 3-slot special queue; active effects sit on
  the board's top-right corner),
  other players' boards (half size) on the right. Block rows use a calm plum-to-orange gradient
  (`ROW_COLORS`) so the bright special blocks stand out. Numbers are per viewer like Stackwar (1 = you).
- 800x600 logical board, 12 columns x 18 rows of space, starting with 8 touching rows; ←/→ or A/D move,
  up/down do nothing yet; Space launches from a centered paddle (host: Space also starts a match).
- Paddle bounces like a half circle: the hit point alone decides the new direction (center = straight up,
  ends = 60° to that side). Blocks bounce off the side hit; the ball speeds up a little per block.
- Losing your last ball costs a life (Multiball: only when every ball is gone), then a 5 s wait before
  the ball is back on a centered paddle (solo: no wait, the ball is back at once; Space launches).
- Modes: **solo** (1 player): endless; each row's worth of blocks broken brings a new row in at the top,
  level up every 5 rows, i.e. every 60 blocks broken (+5% ball speed each; solo's per-block speed-up is also half of multiplayer's;
  losing a life resets the ball to its starting speed in every mode, and in solo the level stays but only
  levels gained after that speed it up again). From level 2, new solo rows mix in stone: 6% of blocks,
  +3% per level, max 30% (`soloRockRate`); over when blocks reach the bottom row or lives run out.
  **Multiplayer (both modes)**: every 24 blocks a player breaks adds a row to every other living player's
  board (server counts from the snapshot `broken` totals, `ROW_EVERY` in `block.js`, sends `addrows`);
  rows push everything down and come in at the top; a board already full to the bottom row takes no more.
  **Clear race**: identical boards, first to clear every block wins, unlimited lives (misses just cost
  the 5 s wait). **Lives**: 3 lives, a cleared board refills, last player with lives left wins.
  Team mode is planned. Solo will later get random artifacts/shapes at higher stages.
- Stone (from Random, and solo rows) takes two hits: the first cracks it ('y', darker with a crack, 5 pts),
  the second breaks it (5 more); only the break counts as a block broken.
- Specials: ~7% of blocks carry a letter; breaking one adds it to your queue (max 3, oldest dropped);
  1-6 fires it at that player (1 = you), X discards, or click a board. R Random (stone boulder or
  stalactite), A Add Line (2 rows on the target's board, same as row growth), C Clear Line (lowest row), M Multiball (doubles balls; triples in solo), E Explosivo
  (5 s, stacks: each block a ball breaks also breaks the blocks touching its 4 sides, no chain; a bit
  rarer, weight 2 like Q), S Slow Ball / F Fast Ball (half /
  double speed 10 s), B Big Paddle / T Tiny Paddle (double / half width 10 s; in solo every timed special
  lasts twice as long, 20 s, except Explosivo which is 10 s), Q Earthquake (shuffles
  the board, buries specials away from the exposed edge, then knocks 4-6 blocks with open space under them
  down 1-2 rows toward the paddle, never into the bottom two rows).
- Solo runs never spawn A (Add Line), R (Random), T (Tiny Paddle), F (Fast Ball) or Q (Earthquake) blocks (`SOLO_EXCLUDED`). Clear Line scores every block
  it removes like a break (10, stone 5) and counts toward blocks broken, in every mode; in solo it doesn't
  advance the new-row counter.

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
