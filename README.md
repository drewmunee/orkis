# Stackwar

Multiplayer falling-block battle game. Every player gets the same piece queue.
Clearing 2+ lines at once sends garbage lines to everyone else; garbage lines can
contain lettered special blocks. Clear them to collect specials, then press a
player's number (1–6) to fire your next special at that player.

## Run

    npm install
    node server.js        # http://localhost:3000  (PORT env var to change)

Open the page in several browsers, use the same room code, and the host presses Start.
