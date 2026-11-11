// Player avatars (chosen in ⚙ Settings, sent when joining a game, shown next to names). Only these are
// accepted, so a player can't put arbitrary text there. Keep in sync with AVATARS in public/common.js.
const AVATARS = ['⚡', '👻', '✂', '🐌', '👅', '💣', '♥'];
const clean = a => AVATARS.includes(a) ? a : null;
module.exports = { AVATARS, clean };
