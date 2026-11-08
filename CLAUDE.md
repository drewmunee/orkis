# Project notes

Stackwar: multiplayer falling-block battle game. Node.js server (`server.js`, WebSockets via `ws`)
plus a plain HTML/CSS/JS client in `public/`. Deployed on Render, which auto-deploys from `main`.

## Product decisions
- **Desktop + keyboard only.** Do not spend effort on phone/touch support or mobile layouts.
  Optimize for people at a computer with a keyboard.
- Gamepad/controller support would be welcome later, but it is low priority.
- Every player gets the same piece queue (shared seed from the server).
- Clearing 2/3/4 lines sends 1/2/4 garbage lines to every other living player.
- Specials are fired at one chosen player by pressing that player's number (1–6); your own
  number targets yourself. Never apply a special to all players at once.
- The light/dark theme is chosen with the Theme dropdown (System/Dark/Light), saved per browser.
