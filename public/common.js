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

  // ---------- settings menu (replaces the old theme dropdown on every page) ----------
  // Avatars shown next to your name in every game (the item emojis from Snakewar, for now).
  // The server keeps the same list (avatars.js) and ignores anything else.
  const AVATARS = ['⚡', '👻', '✂', '🐌', '👅', '💣', '♥'];
  // Snakewar's team shades (same order as TEAM_SHADES in snakewar.js)
  const TEAM_SHADES = {
    red: ['#ff3b3b', '#ff9a1f', '#ffd400', '#ff5fa8', '#b3122e', '#ffb38a'],
    blue: ['#2f6bff', '#1fbf5a', '#9b5cff', '#19c8e6', '#0f8f8a', '#8fb4ff'],
  };
  const OPTIONS = {
    theme: [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']],
    controls: [['arrows', 'Arrow keys'], ['wasd', 'WASD']],
    // Snakewar only: extra two-key steering schemes (your normal steering keys keep working too)
    snakeKeys: [['normal', 'Normal'], ['nokia', 'NOKIA'], ['vim', 'VIM']],
    avatar: [['', 'None'], ...AVATARS.map(a => [a, a])],
    // Snakewar team mode: which of the 6 team shades your snake uses (the same shade on red or blue)
    teamShade: [['', 'Any'], ...[0, 1, 2, 3, 4, 5].map(i => [String(i), `<span class="shade2" title="Shade ${i + 1}"><i style="background:${TEAM_SHADES.red[i]}"></i><i style="background:${TEAM_SHADES.blue[i]}"></i></span>`])],
  };
  const DEFAULTS = { theme: 'system', controls: 'arrows', snakeKeys: 'normal', avatar: '', teamShade: '' };
  const SNAKE_HINTS = {
    normal: 'Steer with your Controls keys above',
    nokia: 'Numpad 1 / 9: moving sideways, 1 turns up and 9 turns down; moving up or down, 1 turns left and 9 turns right',
    vim: 'H / L: moving sideways, H turns up and L turns down; moving up or down, H turns left and L turns right',
  };
  const avatar = () => AVATARS.includes(settings.avatar) ? settings.avatar : '';
  // HTML for a player's avatar (from a player object sent by the server), or '' if they have none
  const avatarHtml = p => p && AVATARS.includes(p.avatar) ? `<span class="av" aria-hidden="true">${p.avatar}</span>` : '';
  // Controls: 'arrows' or 'wasd'. Until someone picks, games that always took both (Snakewar, Blockwar)
  // keep accepting both, so nobody's keys stop working; Stackwar defaults to the arrow-key layout.
  const controls = () => settings.controls || null;
  function mountSettings(host) {
    if (!host) return;
    host.classList.add('settings-host');
    host.innerHTML = `<button type="button" class="settings-btn" aria-haspopup="dialog" aria-expanded="false">⚙ Settings</button>
      <div class="settings-pop hidden" role="dialog" aria-label="Settings">
        <div class="settings-row"><div class="settings-label">Theme</div><div class="seg" data-key="theme"></div></div>
        <div class="settings-row"><div class="settings-label">Controls</div><div class="seg" data-key="controls"></div><div class="settings-hint" data-hint="controls"></div></div>
        <div class="settings-row"><div class="settings-label">Snakewar steering</div><div class="seg" data-key="snakeKeys"></div><div class="settings-hint" data-hint="snakeKeys"></div></div>
        <div class="settings-row"><div class="settings-label">Avatar <small>shown next to your name</small></div><div class="seg avatars" data-key="avatar"></div></div>
        <div class="settings-row"><div class="settings-label">Team shade <small>Snakewar team mode</small></div><div class="seg avatars" data-key="teamShade"></div></div>
        <div class="settings-note">Saved for this browser.</div>
      </div>`;
    const btn = host.querySelector('.settings-btn'), pop = host.querySelector('.settings-pop');
    const render = () => {
      for (const seg of host.querySelectorAll('.seg')) {
        const key = seg.dataset.key, cur = key === 'avatar' ? avatar() : (settings[key] || DEFAULTS[key]);
        seg.innerHTML = OPTIONS[key].map(([v, l]) => `<button type="button" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('');
        for (const b of seg.children) b.onclick = () => { SW.set(key, b.dataset.v); };
      }
      host.querySelector('[data-hint="controls"]').textContent = (controls() || 'arrows') === 'wasd'
        ? 'WASD to move / steer (Stackwar: W/E rotate, Q rotate back, S soft drop, X discard)'
        : 'Arrow keys to move / steer (Stackwar: ↑/X rotate, Z rotate back, ↓ soft drop, D discard)';
      host.querySelector('[data-hint="snakeKeys"]').textContent = SNAKE_HINTS[settings.snakeKeys] || SNAKE_HINTS.normal;
    };
    const open = on => { pop.classList.toggle('hidden', !on); btn.setAttribute('aria-expanded', on); if (on) render(); };
    btn.onclick = e => { e.stopPropagation(); open(pop.classList.contains('hidden')); btn.blur(); };
    pop.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => open(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
    listeners.push(render);
  }

  // Chat boxes everywhere: keep following new messages unless the reader has scrolled up; scrolling back to
  // the bottom resumes following. Also catches up when the box is shown or resized (a hidden box has no
  // height, which used to leave chats stuck partway up).
  function stickyScroll(el, max = 150) {
    let pinned = true;
    const toBottom = () => { if (pinned) el.scrollTop = el.scrollHeight; };
    el.addEventListener('scroll', () => { if (el.clientHeight) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40; });
    if (window.ResizeObserver) new ResizeObserver(toBottom).observe(el);
    return {
      add(node) { el.appendChild(node); while (el.children.length > max) el.firstChild.remove(); toBottom(); requestAnimationFrame(toBottom); },
      toBottom,
      get pinned() { return pinned; },
    };
  }

  return {
    stickyScroll,
    bid,
    get: (k, d) => settings[k] ?? d,
    set(k, v) { apply({ [k]: v }); saveRemote(); },
    onChange(fn) { listeners.push(fn); },
    controls,
    snakeKeys: () => SNAKE_HINTS[settings.snakeKeys] ? settings.snakeKeys : 'normal',
    AVATARS, avatar, avatarHtml,
    // preferred Snakewar team shade 0-5, or null for "any"
    teamShade: () => /^[0-5]$/.test(String(settings.teamShade ?? '')) ? +settings.teamShade : null,
    mountSettings,
    leaderboardText,
  };
})();
