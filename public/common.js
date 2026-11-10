// Shared by every page: who this browser is, and its saved settings.
//  - SW.bid: a random ID this browser keeps (localStorage 'sw-bid'); sent when joining any game so the
//    leaderboards give one spot per person even if they change username.
//  - SW.get / SW.set: per-browser settings, kept locally and saved on the server against the browser ID,
//    so they can later follow the player (theme today; controls etc. to come).
//  - SW.leaderboardText: the "did I make the leaderboard?" line shown after a solo run.
window.SW = (() => {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const h = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  let bid = store.get('sw-bid');
  if (!bid) { bid = makeId(); store.set('sw-bid', bid); }

  let settings = {};
  try { settings = JSON.parse(store.get('sw-settings') || '{}') || {}; } catch {}
  if (!settings.theme && store.get('sw-theme')) settings.theme = store.get('sw-theme'); // older theme choice
  const listeners = [];
  let saveTimer = null;
  function saveRemote() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bid, settings }) }).catch(() => {});
    }, 400);
  }
  function apply(next, fromServer) {
    settings = { ...settings, ...next };
    store.set('sw-settings', JSON.stringify(settings));
    if (settings.theme) { store.set('sw-theme', settings.theme); document.documentElement.dataset.theme = settings.theme; }
    for (const fn of listeners) fn(settings, fromServer);
  }
  // pull this browser's saved settings from the server (they win over local ones)
  fetch('/api/settings?bid=' + encodeURIComponent(bid)).then(r => r.ok ? r.json() : {}).then(d => {
    if (d && Object.keys(d).length) apply(d, true); else if (Object.keys(settings).length) saveRemote();
  }).catch(() => {});

  // "did I make the leaderboard?" for the result message after a solo run
  function leaderboardText(r, unit) {
    if (!r || r.error) return 'Couldn\'t save your score to the leaderboard';
    if (r.onBoard) return r.best > r.prevBest ? `🏅 You made the leaderboard: #${r.rank}!` : `You're #${r.rank} on the leaderboard with your best of ${r.best}`;
    return `Not on the leaderboard yet: top 10 needs ${r.cutoff + 1} ${unit}`;
  }

  return {
    bid,
    get: (k, d) => settings[k] ?? d,
    set(k, v) { apply({ [k]: v }); saveRemote(); },
    onChange(fn) { listeners.push(fn); },
    leaderboardText,
  };
})();
