# Project notes

Stackwar: multiplayer falling-block battle game. Node.js server (`server.js`, WebSockets via `ws`)
plus a plain HTML/CSS/JS client in `public/`. Deployed on Render, which auto-deploys from `main`.

## Product decisions
- **Desktop + keyboard only.** Do not spend effort on phone/touch support or mobile layouts.
  Optimize for people at a computer with a keyboard.
- Gamepad/controller support would be welcome later, but it is low priority.
- Every player gets the same piece queue (shared seed from the server).
- Players can save one piece (C or Shift). Bringing it back swaps it with the current piece; allowed once per piece.
- Clearing 2/3/4 lines sends 1/2/4 garbage lines to every other living player.
- Specials are fired at one chosen player by pressing that player's number (1–6); your own
  number targets yourself. Never apply a special to all players at once.
- The light/dark theme is chosen with the Theme dropdown (System/Dark/Light), saved per browser.

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
