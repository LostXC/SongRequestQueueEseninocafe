/* =============================================================================
 * Eseninocafe Song Request Queue — client (host engine + viewer UI)
 * =============================================================================
 *
 * ONE page, TWO modes, auto-detected on load:
 *
 *   HOST MODE  — runs on the streamer's PC. Detected because this machine can
 *                reach Streamer.bot (ws://127.0.0.1:8080) AND YouTube Music
 *                Desktop (http://127.0.0.1:9863). The host does ALL the real
 *                work: hears channel-point redeems, searches song metadata,
 *                controls YouTube Music, and pushes the authoritative queue up
 *                to the Render server.
 *
 *   VIEWER MODE — runs on a mod's device anywhere. Those localhost connections
 *                fail, so the page asks for the mod code, then shows the live
 *                queue (via SSE) with Accept / Force / Decline buttons. It NEVER
 *                touches localhost — only this page's own origin.
 *
 * WHAT THE HOST TAB CONNECTS TO (and nothing else — verify in DevTools):
 *   1. ws://127.0.0.1:8080            Streamer.bot      (local, hears redeems)
 *   2. http://127.0.0.1:9863          YouTube Music App (local, reads + controls)
 *   3. this page's own origin         Render sync server (relays queue to mods)
 *   Plus public, read-only metadata lookups (MusicBrainz / iTunes / YouTube) to
 *   identify songs — see GetSongInfo() and ResolveYouTubeVideoId() below.
 * ========================================================================== */

'use strict';

// --- where the sync server lives: always this page's own origin --------------
const SERVER = window.location.origin;

const params = new URLSearchParams(window.location.search);

// --- localhost services the HOST talks to (commented at the top of the file) -
const SB = { host: '127.0.0.1', port: 8080 };
const YTMD = {
  base: 'http://127.0.0.1:9863',
  appId: 'eseninocafe-song-queue',
  appName: 'Eseninocafe Song Queue',
  appVersion: '1.0.0',
};

// --- browser-local storage keys (streamer's machine only) --------------------
const STORE = {
  ytmToken: 'srq_ytmd_token',
  hostSecret: 'srq_host_secret',
  ytApiKey: 'srq_yt_api_key',
};

// =============================================================================
//  DOM references
// =============================================================================
const el = (id) => document.getElementById(id);
const ui = {
  roleBadge: el('roleBadge'),
  detecting: el('detecting'),
  login: el('login'),
  loginForm: el('loginForm'),
  codeInput: el('codeInput'),
  loginError: el('loginError'),
  hostSetup: el('hostSetup'),
  ytmAuthCode: el('ytmAuthCode'),
  ytmAuthStatus: el('ytmAuthStatus'),
  hostSecretForm: el('hostSecretForm'),
  hostSecretInput: el('hostSecretInput'),
  offlineBanner: el('offlineBanner'),
  queueUI: el('queueUI'),
  reviewList: el('reviewList'),
  reviewEmpty: el('reviewEmpty'),
  reviewCount: el('reviewCount'),
  playList: el('playList'),
  playEmpty: el('playEmpty'),
  playCount: el('playCount'),
  player: el('player'),
  npArt: el('npArt'),
  npTitle: el('npTitle'),
  npArtist: el('npArtist'),
  npCurrent: el('npCurrent'),
  npDuration: el('npDuration'),
  npFill: el('npFill'),
  songCardTemplate: el('songCardTemplate'),
};

// `role` decides how buttons behave: host acts locally, viewer asks the server.
let role = null;

// =============================================================================
//  Boot: detect the mode, then run the matching path.
// =============================================================================
(async function boot() {
  const mode = await detectMode();
  if (mode === 'host') {
    role = 'host';
    ui.roleBadge.textContent = 'HOST';
    ui.roleBadge.className = 'badge host';
    await initHost();
  } else {
    role = 'viewer';
    ui.roleBadge.textContent = 'VIEWER';
    ui.roleBadge.className = 'badge viewer';
    initViewer();
  }
})();

// -----------------------------------------------------------------------------
// Mode detection. Host requires BOTH localhost services to be reachable.
// `?viewer` / `?host` URL flags force a mode (handy for testing on the host PC).
// -----------------------------------------------------------------------------
async function detectMode() {
  if (params.has('viewer')) return 'viewer';
  if (params.has('host')) return 'host';
  const [sb, ytm] = await Promise.all([
    canReachWS(`ws://${SB.host}:${SB.port}/`), // Streamer.bot WebSocket server
    canReachHTTP(`${YTMD.base}/metadata`),     // YTMDesktop companion server
  ]);
  return sb && ytm ? 'host' : 'viewer';
}

// Resolve true if a WebSocket to `url` opens (used only to probe Streamer.bot).
function canReachWS(url, ms = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => { finish(true); try { ws.close(); } catch (_) {} };
      ws.onerror = () => finish(false);
    } catch (_) { finish(false); }
    setTimeout(() => finish(false), ms);
  });
}

// Resolve true if an HTTP GET to `url` succeeds (used to probe YTMDesktop).
async function canReachHTTP(url, ms = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch (_) { return false; }
}

/* =============================================================================
 *  VIEWER MODE (mods)
 * ========================================================================== */
let session = null; // mod session token from /login

function initViewer() {
  ui.detecting.classList.add('hidden');
  ui.login.classList.remove('hidden');

  ui.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    ui.loginError.classList.add('hidden');
    try {
      const r = await fetch(`${SERVER}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ui.codeInput.value }),
      });
      if (!r.ok) throw new Error('bad code');
      session = (await r.json()).token;
      ui.login.classList.add('hidden');
      enterQueueUI();
      subscribeToState(); // start receiving live queue over SSE
    } catch (_) {
      ui.loginError.classList.remove('hidden');
    }
  });
}

// Subscribe to the server's live state stream and render every update.
function subscribeToState() {
  const es = new EventSource(`${SERVER}/events`);
  es.onmessage = (ev) => {
    try { render(JSON.parse(ev.data)); } catch (_) {}
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// A mod's button press is a REQUEST: we hand it to the server, which queues it
// for the host to execute. The UI updates when the next SSE state arrives.
async function sendModAction(type, id) {
  if (!session) return;
  try {
    await fetch(`${SERVER}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      body: JSON.stringify({ type, id }),
    });
  } catch (e) { console.error('action failed', e); }
}

/* =============================================================================
 *  HOST MODE (the streamer's PC) — the engine. Heavily commented on purpose.
 * ========================================================================== */

// The host's authoritative state. This — not the server — is the source of truth.
const host = {
  reviewQueue: [], // items awaiting a mod/streamer decision
  playQueue: [],   // approved items, in play order
  nowPlaying: null, // mirror of the real YouTube Music player
};

let hostSecret = null; // gates /host/* calls; entered once, saved on this PC
let ytmToken = null;   // YouTube Music auth token; obtained once, saved on this PC

async function initHost() {
  ui.detecting.classList.add('hidden');

  // 1) Host secret — the only thing a mod's browser couldn't supply. Read from
  //    ?key=, else localStorage, else ask once and remember on this machine.
  hostSecret = params.get('key') || localStorage.getItem(STORE.hostSecret);
  if (!hostSecret) hostSecret = await askHostSecret();
  localStorage.setItem(STORE.hostSecret, hostSecret);

  // 2) YouTube Music token — reuse the saved one, otherwise run the handshake.
  ytmToken = localStorage.getItem(STORE.ytmToken);
  if (!ytmToken) {
    ui.hostSetup.classList.remove('hidden');
    el('ytmAuthBox').classList.remove('hidden');
    ytmToken = await runYtmAuth();
    localStorage.setItem(STORE.ytmToken, ytmToken);
  }

  // Setup done — show the queue and start the engine.
  ui.hostSetup.classList.add('hidden');
  enterQueueUI();

  connectStreamerbot(); // hear channel-point redeems
  connectYtmRealtime(); // read the live now-playing state
  startHostHeartbeat(); // tell the server we're alive
  startActionPolling(); // pick up mod actions to execute
  scheduleSync(true);   // push initial (empty) state up
  renderHost();
}

// Show the host-secret form and resolve once the streamer saves it.
function askHostSecret() {
  return new Promise((resolve) => {
    ui.hostSetup.classList.remove('hidden');
    el('hostSecretBox').classList.remove('hidden');
    ui.hostSecretForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = ui.hostSecretInput.value.trim();
      if (v) { el('hostSecretBox').classList.add('hidden'); resolve(v); }
    });
  });
}

// ---- YouTube Music auth handshake (first run only) --------------------------
// POST /auth/requestcode -> {code}; show it; POST /auth/request -> {token}.
// The /auth/request call blocks until the streamer approves the popup in YTMD
// (up to ~30s). The token is reusable and saved in localStorage afterward.
async function runYtmAuth() {
  const codeResp = await fetch(`${YTMD.base}/api/v1/auth/requestcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: YTMD.appId, appName: YTMD.appName, appVersion: YTMD.appVersion }),
  });
  const { code } = await codeResp.json();
  ui.ytmAuthCode.textContent = code || '????';
  ui.ytmAuthStatus.textContent = 'Waiting for you to approve in YouTube Music…';

  const tokResp = await fetch(`${YTMD.base}/api/v1/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: YTMD.appId, code }),
  });
  const data = await tokResp.json();
  if (!data.token) {
    ui.ytmAuthStatus.textContent = 'Authorization failed. Reload to try again.';
    throw new Error('YTMD auth failed');
  }
  ui.ytmAuthStatus.textContent = 'Authorized ✓';
  return data.token;
}

// ---- Streamer.bot: hear channel-point redeems -------------------------------
function connectStreamerbot() {
  // The browser talks to Streamer.bot over its local WebSocket server.
  const client = new StreamerbotClient({ host: SB.host, port: SB.port });
  // The existing "song request" reward already fires Twitch.RewardRedemption.
  client.on('Twitch.RewardRedemption', (payload) => handleRedeem(payload.data));
}

// A redeem came in. If it's a "song request", identify the song and queue it
// for review. Mirrors the filter the existing widget already uses.
async function handleRedeem(data) {
  const title = (data && data.reward && data.reward.title) || '';
  if (!title.toLowerCase().includes('song request')) return;

  const query = (data.user_input || '').trim();
  const user = data.user_name || 'someone';
  if (!query) return; // nothing to search on

  // Identify the song (album art / artist / duration) using the same
  // MusicBrainz -> iTunes pipeline proven in the multichat widget.
  const info = await GetSongInfo(query).catch(() => null);

  // Resolve a YouTube Music videoId so we can actually play it.
  const seedTitle = info ? info.title : query;
  const seedArtist = info ? info.artist : '';
  const videoId = await ResolveYouTubeVideoId(seedTitle, seedArtist).catch(() => null);

  host.reviewQueue.push({
    id: crypto.randomUUID(),
    user,
    query,
    videoId: videoId || null,
    playable: !!videoId, // if false, mods see a "not playable" warning
    title: info ? info.title : query,
    artist: info ? info.artist : '',
    album: info ? info.album : '',
    durationMs: info ? info.durationMs : 0,
    albumArt: info ? info.albumArt : '',
    createdAt: Date.now(),
  });

  scheduleSync(true);
  renderHost();
}

// ---- Apply an action to the host's real queue (+ YouTube Music) -------------
// Used both for the host's own button clicks and for mod actions polled from
// the server. The host is the ONLY place these are executed.
function hostApplyAction(type, id) {
  const inReview = host.reviewQueue.find((i) => i.id === id);
  const inPlay = host.playQueue.find((i) => i.id === id);
  const item = inReview || inPlay;
  if (!item) return;

  const removeEverywhere = () => {
    host.reviewQueue = host.reviewQueue.filter((i) => i.id !== id);
    host.playQueue = host.playQueue.filter((i) => i.id !== id);
  };

  if (type === 'decline') {
    // Drop it entirely.
    removeEverywhere();
  } else if (type === 'accept') {
    // Approve: move to the end of the play queue.
    if (inReview) {
      host.reviewQueue = host.reviewQueue.filter((i) => i.id !== id);
      host.playQueue.push(item);
    }
    // Cold start: if nothing has ever played, kick the queue off.
    if (!host.nowPlaying) advanceNext();
  } else if (type === 'force') {
    // Play immediately and put it at the front of the queue.
    removeEverywhere();
    host.playQueue.unshift(item);
    playNow(item);
  }

  scheduleSync(true);
  renderHost();
}

// Pop the next approved song and play it.
function advanceNext() {
  const next = host.playQueue.shift();
  if (next) playNow(next);
}

// Play a specific item right now: fire the deep link and optimistically set the
// now-playing mirror (the real YTMD socket will correct it within ~1s).
function playNow(item) {
  if (item.videoId) fireYtmd(item.videoId);
  host.nowPlaying = {
    title: item.title || item.query,
    artist: item.artist || '',
    album: item.album || '',
    albumArt: item.albumArt || '',
    videoId: item.videoId || null,
    durationSeconds: (item.durationMs || 0) / 1000,
    progress: 0,
    trackState: 2, // buffering — the real state arrives shortly
    updatedAt: Date.now(),
  };
}

// ---- Control YouTube Music: fire the ytmd:// deep link ----------------------
// `ytmd://play/<videoId>` is handed to the OS, which routes it to the YouTube
// Music Desktop app. We use a throwaway <a> click so the host tab itself never
// navigates. (Alternative, if you prefer a silent token-authed call: POST
// `${YTMD.base}/api/v1/command` { command:'changeVideo', data:{ videoId } } with
// an Authorization: Bearer <ytmToken> header — see README. Kept to the proven
// deep-link path here.)
function fireYtmd(videoId) {
  const a = document.createElement('a');
  a.href = `ytmd://play/${videoId}`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 500);
}

// ---- YouTube Music realtime: read the live now-playing state ----------------
// Socket.IO to the companion server's realtime namespace, authed with the token.
// Same connection shape the existing music widget uses.
let lastSeenVideoId = null;
let advancedFromVideoId = null; // guards against double auto-advance

function connectYtmRealtime() {
  if (typeof io === 'undefined') return setTimeout(connectYtmRealtime, 1000);

  const socket = io(`${YTMD.base}/api/v1/realtime`, {
    transports: ['websocket'],
    auth: { token: ytmToken },
  });

  socket.on('state-update', (stateData) => onYtmState(stateData));
  socket.on('disconnect', () => { /* socket.io auto-reconnects */ });
}

function onYtmState(stateData) {
  if (!stateData || !stateData.player || !stateData.video) return;
  const v = stateData.video;
  const p = stateData.player;

  const vid = v.id || null;
  const duration = v.durationSeconds || 0;
  const progress = p.videoProgress || 0;
  const trackState = p.trackState; // -1 unknown, 0 paused, 1 playing, 2 buffering

  // Mirror the real player into nowPlaying (this drives the bottom bar + mods).
  const prevAlbum = host.nowPlaying && host.nowPlaying.videoId === vid ? host.nowPlaying.album : '';
  const thumb = v.thumbnails && v.thumbnails.length ? v.thumbnails[v.thumbnails.length - 1].url : '';
  host.nowPlaying = {
    title: v.title || '',
    artist: v.author || '',
    album: prevAlbum || '',
    albumArt: thumb || (host.nowPlaying ? host.nowPlaying.albumArt : ''),
    videoId: vid,
    durationSeconds: duration,
    progress,
    trackState,
    updatedAt: Date.now(),
  };

  if (vid !== lastSeenVideoId) lastSeenVideoId = vid; // a new song is playing

  // Auto-advance: when the current track reaches its end, play the next queued
  // song. Guarded so we only fire once per finished track.
  const nearEnd = duration > 0 && progress >= duration - 1.2;
  if (nearEnd && vid && advancedFromVideoId !== vid && host.playQueue.length) {
    advancedFromVideoId = vid;
    advanceNext();
    scheduleSync(true);
  }

  scheduleSync(false); // routine now-playing tick (throttled)
  renderHost();
}

// ---- Push authoritative state up to the server (throttled) ------------------
let lastSyncAt = 0;
let syncTimer = null;

function scheduleSync(force) {
  const now = Date.now();
  if (force || now - lastSyncAt >= 1200) {
    doSync();
  } else if (!syncTimer) {
    syncTimer = setTimeout(() => { syncTimer = null; doSync(); }, 1200 - (now - lastSyncAt));
  }
}

async function doSync() {
  lastSyncAt = Date.now();
  try {
    await fetch(`${SERVER}/host/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostSecret}` },
      body: JSON.stringify({
        reviewQueue: host.reviewQueue,
        playQueue: host.playQueue,
        nowPlaying: host.nowPlaying,
      }),
    });
  } catch (e) { console.error('sync failed', e); }
}

// ---- Heartbeat: tell the server we're alive so mods know playback is live ---
function startHostHeartbeat() {
  const beat = () => {
    fetch(`${SERVER}/host/hello`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostSecret}` },
    }).catch(() => {});
  };
  beat();
  setInterval(beat, 5000);
}

// ---- Poll the server for mod actions and execute them locally ---------------
function startActionPolling() {
  setInterval(async () => {
    try {
      const r = await fetch(`${SERVER}/host/actions`, {
        headers: { Authorization: `Bearer ${hostSecret}` },
      });
      if (!r.ok) return;
      const { actions } = await r.json();
      for (const a of actions || []) hostApplyAction(a.type, a.id);
    } catch (_) { /* network blip; try again next tick */ }
  }, 1000);
}

/* =============================================================================
 *  SHARED RENDERING (host renders local state; viewer renders SSE state)
 * ========================================================================== */

// The host renders directly from its own authoritative state.
function renderHost() {
  render({
    reviewQueue: host.reviewQueue,
    playQueue: host.playQueue,
    nowPlaying: host.nowPlaying,
    hostConnected: true,
  });
}

function enterQueueUI() {
  ui.queueUI.classList.remove('hidden');
  ui.player.classList.remove('hidden');
}

function render(s) {
  renderColumn(ui.reviewList, ui.reviewEmpty, ui.reviewCount, s.reviewQueue || [], 'review');
  renderColumn(ui.playList, ui.playEmpty, ui.playCount, s.playQueue || [], 'play');
  updateNowPlaying(s.nowPlaying || null);
  // Mods see a banner when the host is offline; the host never shows it.
  ui.offlineBanner.classList.toggle('hidden', role === 'host' || !!s.hostConnected);
}

function renderColumn(listEl, emptyEl, countEl, items, column) {
  countEl.textContent = items.length;
  emptyEl.classList.toggle('hidden', items.length > 0);
  listEl.innerHTML = '';
  for (const item of items) listEl.appendChild(buildCard(item, column));
}

// Build one song card. Visual structure mirrors the existing widget's music card:
// album art, title, album, artist, duration.
function buildCard(item, column) {
  const node = ui.songCardTemplate.content.cloneNode(true);
  const card = node.querySelector('.song-card');

  const art = node.querySelector('.sc-art');
  if (item.albumArt) { art.src = item.albumArt; } else { art.style.visibility = 'hidden'; }
  art.onerror = () => { art.style.visibility = 'hidden'; };

  node.querySelector('.sc-title').textContent = item.title || item.query || '(unknown)';

  const albumEl = node.querySelector('.sc-album');
  if (item.album) albumEl.textContent = item.album; else albumEl.remove();

  node.querySelector('.sc-artist').textContent = item.artist || '';
  node.querySelector('.sc-duration').textContent = item.durationMs ? FormatSongDuration(item.durationMs) : '';
  node.querySelector('.sc-requester').textContent = item.user || '';

  // Flag songs we couldn't resolve to a playable YouTube videoId.
  if (item.playable === false) {
    card.classList.add('unplayable');
    node.querySelector('.sc-warn').classList.remove('hidden');
  }

  // Action buttons differ per column.
  const actions = node.querySelector('.sc-actions');
  if (column === 'review') {
    actions.appendChild(actionButton('Accept', 'btn-accept', 'accept', item.id));
    actions.appendChild(actionButton('Force', 'btn-force', 'force', item.id));
    actions.appendChild(actionButton('Decline', 'btn-decline', 'decline', item.id));
  } else {
    actions.appendChild(actionButton('Play now', 'btn-force', 'force', item.id));
    actions.appendChild(actionButton('Remove', 'btn-decline', 'decline', item.id));
  }

  return node;
}

function actionButton(label, cls, type, id) {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.addEventListener('click', () => onAction(type, id));
  return b;
}

// Route a button press: the host acts locally; a mod asks the server.
function onAction(type, id) {
  if (role === 'host') hostApplyAction(type, id);
  else sendModAction(type, id);
}

/* =============================================================================
 *  NOW-PLAYING BAR — smooth progress, interpolated between state updates
 *  (same approach as the existing widget: tick locally, re-sync on updates).
 * ========================================================================== */
const np = { secs: 0, dur: 0, playing: false, last: performance.now(), vid: null };

function updateNowPlaying(n) {
  if (!n) {
    ui.npTitle.textContent = '—';
    ui.npArtist.textContent = '';
    ui.npArt.removeAttribute('src');
    np.playing = false; np.secs = 0; np.dur = 0; np.vid = null;
    return;
  }

  const songChanged = n.videoId !== np.vid;
  if (songChanged) {
    np.vid = n.videoId;
    ui.npTitle.textContent = n.title || '—';
    ui.npArtist.textContent = n.artist || '';
    if (n.albumArt) ui.npArt.src = n.albumArt; else ui.npArt.removeAttribute('src');
  }

  np.dur = n.durationSeconds || 0;
  const wasPlaying = np.playing;
  np.playing = n.trackState === 1;

  // Re-sync our local clock to the server progress on song/state change or drift.
  const serverSecs = n.progress || 0;
  let localSecs = np.secs;
  if (wasPlaying) localSecs += (performance.now() - np.last) / 1000;
  if (songChanged || np.playing !== wasPlaying || Math.abs(serverSecs - localSecs) > 2) {
    np.secs = serverSecs;
  }
  np.last = performance.now();
}

// rAF loop: advance the local clock while playing and paint the progress bar.
function tickPlayer() {
  let secs = np.secs;
  if (np.playing && np.dur > 0) secs += (performance.now() - np.last) / 1000;
  secs = Math.max(0, Math.min(np.dur || secs, secs));

  ui.npCurrent.textContent = ConvertSeconds(secs);
  ui.npDuration.textContent = ConvertSeconds(np.dur);
  ui.npFill.style.width = np.dur > 0 ? `${(secs / np.dur) * 100}%` : '0%';

  requestAnimationFrame(tickPlayer);
}
requestAnimationFrame(tickPlayer);

function ConvertSeconds(time) {
  if (!time || time < 0 || isNaN(time)) return '0:00';
  const m = Math.floor(time / 60);
  const s = Math.trunc(time - m * 60);
  return `${m}:${('0' + s).slice(-2)}`;
}

/* =============================================================================
 *  YOUTUBE MUSIC videoId RESOLUTION  (isolated + swappable on purpose)
 * =============================================================================
 *  GetSongInfo() gives us title/artist/album/art but NOT a YouTube Music
 *  videoId, which `ytmd://play/` needs. This function bridges that gap.
 *
 *  Two strategies, in order of preference:
 *    1. YouTube Data API v3 — used only if you supply a key (?ytKey=... once, or
 *       localStorage 'srq_yt_api_key'). Most reliable; Google's API sends CORS
 *       headers so the browser can call it directly. Restrict the key to your
 *       Render domain (HTTP referrer) in the Google Cloud console.
 *    2. Zero-config fallback — scrape the first videoId out of a normal YouTube
 *       search results page, fetched through the same public CORS proxy the
 *       metadata search already uses (corsproxy.io). No key required.
 *
 *  Returns an 11-char videoId string, or null if nothing could be resolved
 *  (the item is still queued, just flagged not-playable).
 * ========================================================================== */
async function ResolveYouTubeVideoId(title, artist) {
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) return null;

  // --- Strategy 1: YouTube Data API v3 (only if a key is configured) ---------
  const ytKey = params.get('ytKey') || localStorage.getItem(STORE.ytApiKey);
  if (ytKey) {
    try {
      const url = 'https://www.googleapis.com/youtube/v3/search'
        + '?part=snippet&type=video&videoCategoryId=10&maxResults=1'
        + '&q=' + encodeURIComponent(query) + '&key=' + encodeURIComponent(ytKey);
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        const vid = j.items && j.items[0] && j.items[0].id && j.items[0].id.videoId;
        if (vid) return vid;
      }
    } catch (e) { console.debug('[videoId] Data API failed, falling back', e); }
  }

  // --- Strategy 2: scrape YouTube search results via public CORS proxy -------
  try {
    const target = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const proxied = 'https://corsproxy.io/?url=' + encodeURIComponent(target);
    const html = await (await fetch(proxied)).text();
    const m = html.match(/"videoId":"([\w-]{11})"/); // first result wins
    if (m) return m[1];
  } catch (e) { console.debug('[videoId] scrape failed', e); }

  return null;
}

/* =============================================================================
 *  SONG METADATA  — reused verbatim from the multichat widget (proven, no key).
 *  MusicBrainz + Cover Art Archive + iTunes, with Spotify/YouTube link seeds.
 *  Returns { title, artist, album, durationMs, albumArt }.
 * ========================================================================== */
function FormatSongDuration(ms) {
  if (!ms) return '?:??';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function ParseSongRequest(text) {
  let parts = text.split(/\s+-\s+/);
  if (parts.length >= 2) return { title: parts[0].trim(), artist: parts.slice(1).join(' - ').trim() };
  parts = text.split(/\s+by\s+/i);
  if (parts.length >= 2) return { title: parts[0].trim(), artist: parts.slice(1).join(' by ').trim() };
  return { title: text.trim(), artist: '' };
}

async function SpotifyInfoFromUrl(url) {
  const resp = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url));
  if (!resp.ok) return null;
  const j = await resp.json();
  return { title: j.title || '', thumbnail: j.thumbnail_url || '' };
}

// Resolve true only if the image URL actually loads (catches dead art links).
function ImageLoads(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const img = new Image();
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    img.onload = () => finish(img.naturalWidth > 1);
    img.onerror = () => finish(false);
    setTimeout(() => finish(false), timeoutMs);
    img.src = url;
  });
}

// Start every candidate loading in parallel; return the highest-priority one
// that loads, so a slow/dead first candidate doesn't block the others.
async function ResolveAlbumArt(candidates) {
  const checks = candidates.map((url) => (url ? ImageLoads(url) : Promise.resolve(false)));
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] && (await checks[i])) return candidates[i];
  }
  return '';
}

async function SearchMusicBrainz(title, artist) {
  const query = artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`;
  const url = 'https://musicbrainz.org/ws/2/recording/?fmt=json&limit=5&query=' + encodeURIComponent(query);
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const rec = ((await resp.json()).recordings || [])[0];
  if (!rec) return null;
  const releaseId = (rec.releases || [])[0] && (rec.releases || [])[0].id;
  const albumArt = releaseId ? `https://coverartarchive.org/release/${releaseId}/front-500` : '';
  return {
    title: rec.title || '',
    artist: (rec['artist-credit'] || []).map((a) => a.name).join(', '),
    album: ((rec.releases || [])[0] || {}).title || '',
    durationMs: rec.length || 0,
    albumArt,
  };
}

async function SearchITunes(title, artist) {
  const term = (title + ' ' + artist).trim();
  const url = 'https://itunes.apple.com/search?entity=song&limit=15&term=' + encodeURIComponent(term);
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const results = (await resp.json()).results || [];
  let pick = results[0];
  if (artist) {
    const a = artist.toLowerCase();
    pick = results.find((x) => (x.artistName || '').toLowerCase().includes(a)) || pick;
  }
  if (!pick) return null;
  const albumArt = pick.artworkUrl100 ? pick.artworkUrl100.replace('100x100bb', '600x600bb') : '';
  return {
    title: pick.trackName || '',
    artist: pick.artistName || '',
    album: pick.collectionName || '',
    durationMs: pick.trackTimeMillis || 0,
    albumArt,
  };
}

// Read a Spotify track's exact metadata from its public embed page, via a CORS
// proxy (no server needed). Returns authoritative title/artist/duration/art.
async function SpotifyEmbedInfo(url) {
  const idMatch = url.match(/track[/:]([A-Za-z0-9]+)/);
  if (!idMatch) return null;
  const embed = 'https://open.spotify.com/embed/track/' + idMatch[1];
  let html;
  try {
    const resp = await fetch('https://corsproxy.io/?url=' + encodeURIComponent(embed));
    if (!resp.ok) return null;
    html = await resp.text();
  } catch (e) { return null; }

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return null;
  let entity;
  try { entity = JSON.parse(m[1]).props.pageProps.state.data.entity; } catch (e) { return null; }
  if (!entity || !entity.name) return null;

  const artist = (entity.artists || []).map((a) => a.name).filter(Boolean).join(', ') || entity.subtitle || '';
  let albumArt = '';
  const vi = (entity.visualIdentity && entity.visualIdentity.image) || [];
  if (vi.length) albumArt = vi.slice().sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0].url;
  if (!albumArt && entity.coverArt && entity.coverArt.sources && entity.coverArt.sources.length) {
    albumArt = entity.coverArt.sources.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
  }
  return { title: entity.name, artist, durationMs: entity.duration || 0, albumArt, authoritative: true };
}

// Strip junk from a (YouTube) title: "(Official Video)", "[Audio]", etc.
function CleanTrackTitle(t) {
  const junk = /official|video|audio|lyric(?:s)?|visuali[sz]er|remaster(?:ed)?|\bhd\b|\b4k\b|\bmv\b|m\/v|explicit|music\s*video|color\s*coded/i;
  return (t || '')
    .replace(/\(([^()]*)\)/g, (full, inner) => (junk.test(inner) ? '' : full))
    .replace(/\[([^\[\]]*)\]/g, (full, inner) => (junk.test(inner) ? '' : full))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Resolve a YouTube link to a {title, artist} seed via public oEmbed.
async function YouTubeInfo(url) {
  let resp;
  try { resp = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url)); }
  catch (e) { return null; }
  if (!resp.ok) return null;
  const j = await resp.json();
  const cleaned = CleanTrackTitle(j.title || '');
  if (!cleaned) return null;
  let title, artist;
  const parts = cleaned.split(/\s+-\s+/);
  if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }
  else { title = cleaned; artist = (j.author_name || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim(); }
  return { title, artist, authoritative: false };
}

async function GetSongInfo(request) {
  const input = (request || '').trim();
  if (!input) { console.warn('[song] empty request'); return null; }

  // Turn the input into a search "seed". A Spotify track embed is authoritative;
  // YouTube links and plain text only seed the search.
  let seed = null;
  if (/open\.spotify\.com\/track|spotify:track:/i.test(input)) {
    seed = await SpotifyEmbedInfo(input);
    if (!seed) {
      const sp = await SpotifyInfoFromUrl(input).catch(() => null);
      if (sp) { const p = ParseSongRequest(sp.title || ''); seed = { title: p.title, artist: p.artist, albumArt: sp.thumbnail, authoritative: false }; }
    }
  } else if (/open\.spotify\.com|spotify:/i.test(input)) {
    const sp = await SpotifyInfoFromUrl(input).catch(() => null);
    if (sp) { const p = ParseSongRequest(sp.title || ''); seed = { title: p.title, artist: p.artist, albumArt: sp.thumbnail, authoritative: false }; }
  } else if (/youtube\.com\/watch|youtu\.be\/|music\.youtube\.com/i.test(input)) {
    seed = await YouTubeInfo(input);
  } else {
    const p = ParseSongRequest(input);
    seed = { title: p.title, artist: p.artist, authoritative: false };
  }

  if (!seed || !seed.title) { console.warn(`[song] could not resolve "${input}"`); return null; }

  // Enrich (album/duration/art + canonical names) via MusicBrainz + iTunes.
  const [mb, itunes] = await Promise.all([
    SearchMusicBrainz(seed.title, seed.artist).catch(() => null),
    SearchITunes(seed.title, seed.artist).catch(() => null),
  ]);
  const enrich = mb || itunes || {};

  let info, artCandidates;
  if (seed.authoritative) {
    info = { title: seed.title, artist: seed.artist, album: enrich.album || '', durationMs: seed.durationMs || enrich.durationMs || 0 };
    artCandidates = [seed.albumArt, itunes && itunes.albumArt, mb && mb.albumArt];
  } else {
    info = enrich.title
      ? { title: enrich.title, artist: enrich.artist, album: enrich.album || '', durationMs: enrich.durationMs || 0 }
      : { title: seed.title, artist: seed.artist, album: '', durationMs: 0 };
    artCandidates = [itunes && itunes.albumArt, mb && mb.albumArt, seed.albumArt];
  }
  info.albumArt = await ResolveAlbumArt(artCandidates);
  return info;
}
