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

// Theme preference key (used in boot() before the toolbar section, so it lives here).
const THEME_KEY = 'srq_theme';

// =============================================================================
//  DOM references
// =============================================================================
const el = (id) => document.getElementById(id);
const ui = {
  topRoleIndicator: el('topRoleIndicator'),
  topThemeBtn: el('topThemeBtn'),
  topThemeIcon: el('topThemeIcon'),
  codeEyeBtn: el('codeEyeBtn'),
  detecting: el('detecting'),
  rolePrompt: el('rolePrompt'),
  chooseHostBtn: el('chooseHostBtn'),
  chooseModBtn: el('chooseModBtn'),
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
  topbar: el('topbar'),
  queueUI: el('queueUI'),
  // toolbar
  viewTitle: el('viewTitle'),
  roleIndicator: el('roleIndicator'),
  themeToggleBtn: el('themeToggleBtn'),
  themeToggleIcon: el('themeToggleIcon'),
  acceptAllBtn: el('acceptAllBtn'),
  declineAllBtn: el('declineAllBtn'),
  viewToggleBtn: el('viewToggleBtn'),
  viewToggleIcon: el('viewToggleIcon'),
  // views
  requestsView: el('requestsView'),
  queueView: el('queueView'),
  reviewList: el('reviewList'),
  reviewEmpty: el('reviewEmpty'),
  playList: el('playList'),
  playEmpty: el('playEmpty'),
  player: el('player'),
  npArt: el('npArt'),
  npTitle: el('npTitle'),
  npArtist: el('npArtist'),
  npCurrent: el('npCurrent'),
  npDuration: el('npDuration'),
  npProgressContainer: el('npProgressContainer'),
  npProgressSvg: el('npProgressSvg'),
  npProgressPath: el('npProgressPath'),
  npThumb: el('npThumb'),
  songCardTemplate: el('songCardTemplate'),
};

// `role` decides how buttons behave: host acts locally, viewer asks the server.
let role = null;

// =============================================================================
//  Boot: detect the mode, then run the matching path.
// =============================================================================
(async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark'); // theme the bg from the start
  // Top-bar controls (present on the pre-queue screens) work right away.
  if (ui.topThemeBtn) ui.topThemeBtn.addEventListener('click', toggleTheme);
  if (ui.codeEyeBtn) ui.codeEyeBtn.addEventListener('click', () => {
    const i = ui.codeInput;
    i.type = i.type === 'password' ? 'text' : 'password';
    ui.codeEyeBtn.classList.toggle('open', i.type === 'text');
  });
  const decision = await detectMode();
  if (decision === 'host') return startHost();       // forced via ?host
  if (decision === 'viewer') return startViewer();   // can't host, or forced ?viewer
  // 'choose' — this machine CAN host, so let the person pick rather than assume.
  showRolePrompt();
})();

// Run the host path.
async function startHost() {
  role = 'host';
  setRoleIndicators();
  await initHost();
}

// Run the viewer (mod) path.
function startViewer() {
  role = 'viewer';
  setRoleIndicators();
  initViewer();
}

// Point every role-indicator icon (top bar + queue toolbar) at host/viewer.
function setRoleIndicators() {
  const src = role === 'host' ? '/icons/host-role.svg' : '/icons/viewer-role.svg';
  const title = role === 'host' ? 'Host' : 'Viewer';
  if (ui.topRoleIndicator) { ui.topRoleIndicator.src = src; ui.topRoleIndicator.title = title; }
  if (ui.roleIndicator) { ui.roleIndicator.src = src; ui.roleIndicator.title = title; }
}

// This machine can host — show the "host or mod?" choice and branch on the click.
function showRolePrompt() {
  ui.detecting.classList.add('hidden');
  ui.rolePrompt.classList.remove('hidden');
  ui.chooseHostBtn.addEventListener('click', () => { ui.rolePrompt.classList.add('hidden'); startHost(); });
  ui.chooseModBtn.addEventListener('click', () => { ui.rolePrompt.classList.add('hidden'); startViewer(); });
}

// -----------------------------------------------------------------------------
// Mode detection. Returns:
//   'host'   — forced via ?host
//   'viewer' — forced via ?viewer, or this machine can't reach the local services
//   'choose' — both local services are reachable, so ASK whether host or mod
// (`?host` / `?viewer` URL flags skip the prompt — handy for testing.)
// -----------------------------------------------------------------------------
async function detectMode() {
  if (params.has('viewer')) return 'viewer';
  if (params.has('host')) return 'host';
  const [sb, ytm] = await Promise.all([
    canReachWS(`ws://${SB.host}:${SB.port}/`), // Streamer.bot WebSocket server
    canReachHTTP(`${YTMD.base}/metadata`),     // YTMDesktop companion server
  ]);
  return sb && ytm ? 'choose' : 'viewer';
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
  //    If YTMD isn't reachable we DON'T block: the queue stays fully manageable
  //    (accept/decline/reorder all work), just without playback until YTMD is up.
  ytmToken = localStorage.getItem(STORE.ytmToken);
  if (!ytmToken) {
    ui.hostSetup.classList.remove('hidden');
    el('ytmAuthBox').classList.remove('hidden');
    try {
      ytmToken = await runYtmAuth();
      localStorage.setItem(STORE.ytmToken, ytmToken);
    } catch (e) {
      console.warn('[host] YouTube Music not reachable — running without playback control', e);
      ytmToken = null;
    }
  }

  // Setup done — show the queue and start the engine.
  ui.hostSetup.classList.add('hidden');
  enterQueueUI();

  connectStreamerbot();             // hear channel-point redeems
  if (ytmToken) connectYtmRealtime(); // read the live now-playing state (needs the token)
  startHostHeartbeat();             // tell the server we're alive
  startActionPolling();             // pick up mod actions to execute
  scheduleSync(true);               // push initial (empty) state up
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
  try {
    const client = new StreamerbotClient({ host: SB.host, port: SB.port });
    // The existing "song request" reward already fires Twitch.RewardRedemption.
    client.on('Twitch.RewardRedemption', (payload) => handleRedeem(payload.data));
  } catch (e) {
    console.warn('[host] Streamer.bot not reachable — no redeems will arrive', e);
  }
}

// A redeem came in. If it's a "song request", identify the song and queue it
// for review. Mirrors the filter the existing widget already uses.
async function handleRedeem(data) {
  const title = (data && data.reward && data.reward.title) || '';
  if (!title.toLowerCase().includes('song request')) return;

  const query = (data.user_input || '').trim();
  const user = data.user_name || 'someone';
  if (!query) return; // nothing to search on

  // Reward details for the card header ("Redeemed <title> <icon> <cost>").
  const reward = data.reward || {};
  const rewardImage = (reward.image && reward.image.url_2x)
    || (reward.defaultImage && reward.defaultImage.url_2x) || '';

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
    rewardTitle: reward.title || 'Song Request',
    rewardImage,
    cost: reward.cost || 0,
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
    playNow(item);
  } else if (type === 'moveup' || type === 'movedown') {
    // Reorder within the play queue by swapping with a neighbour.
    const idx = host.playQueue.findIndex((i) => i.id === id);
    const swap = type === 'moveup' ? idx - 1 : idx + 1;
    if (idx === -1 || swap < 0 || swap >= host.playQueue.length) return;
    [host.playQueue[idx], host.playQueue[swap]] = [host.playQueue[swap], host.playQueue[idx]];
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

let toolbarInited = false;

function enterQueueUI() {
  ui.topbar.classList.add('hidden'); // the toolbar replaces the brand bar here
  ui.queueUI.classList.remove('hidden');
  ui.player.classList.remove('hidden');
  // role indicator icon reflects who this tab is
  setRoleIndicators();
  ui.roleIndicator.title = role === 'host' ? 'Host' : 'Viewer';
  if (!toolbarInited) { initToolbar(); toolbarInited = true; }
  ui.npArt.onerror = () => { ui.npArt.src = BLANK_PX; };
  ui.npArt.src = BLANK_PX; // red placeholder until a song loads
  setupPlayerBorder();      // boiling border around the player card
}

/* ---------------------------------------------------------------------------
 *  PLAYER BOILING BORDER — animated begin (stroke draw + fade-in) and end
 *  (scribble eraser wipe), ported from the YT Music widget (no skull). Driven
 *  by the track state: it appears when a song plays, disappears when it stops.
 * ------------------------------------------------------------------------- */
const PLAYER_P = 10;                 // padding; matches .np-border-canvas offset (-10px)
let playerBorder = null;             // { ctx, basePath, contentW, contentH, cw, ch, P, seed }
let playerAnimState = 'HIDDEN';      // HIDDEN | APPEARING | VISIBLE | DISAPPEARING
let playerAnimStart = performance.now();
let playerEraserPts = null;
let playerLoopStarted = false;

// Measure the player card and (re)build its border canvas. Starts the single
// animation loop the first time.
function setupPlayerBorder() {
  const wrap = document.querySelector('.np-card-wrapper');
  const canvas = document.querySelector('.np-border-canvas');
  if (!wrap || !canvas || wrap.offsetWidth === 0) return;
  const contentW = wrap.offsetWidth, contentH = wrap.offsetHeight;
  const P = PLAYER_P, R = BOIL_CFG.cornerRadius;
  const cw = contentW + P * 2, ch = contentH + P * 2;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = cw * ratio; canvas.height = ch * ratio;
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const seed = playerBorder ? playerBorder.seed : Math.random() * 1000;
  playerBorder = { ctx, basePath: boilBuildBasePath(contentW, contentH, R), contentW, contentH, cw, ch, P, seed };
  playerEraserPts = null; // size changed → rebuild the eraser path
  initPlayerEraserMask(contentW, contentH, P);
  if (!playerLoopStarted) { playerLoopStarted = true; requestAnimationFrame(playerBorderTick); }
}

// Toggle the appear/disappear animation (same state logic as the widget).
function setPlayerVisibility(visible) {
  if (visible && (playerAnimState === 'HIDDEN' || playerAnimState === 'DISAPPEARING')) {
    playerAnimState = 'APPEARING';
    playerAnimStart = performance.now();
    playerEraserPts = null;
    const ep = document.getElementById('np-eraser-path');
    if (ep) ep.setAttribute('d', '');
  } else if (!visible && (playerAnimState === 'VISIBLE' || playerAnimState === 'APPEARING')) {
    playerAnimState = 'DISAPPEARING';
    playerAnimStart = performance.now();
  }
}

// SVG mask the eraser "wipes" the player card with on the way out.
function initPlayerEraserMask(W, H, P) {
  let svg = document.getElementById('np-eraser-svg');
  const x = -2000, y = -2000, w = 4000, h = 4000;
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'np-eraser-svg';
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none;';
    document.body.appendChild(svg);
  }
  svg.innerHTML =
    `<defs><mask id="np-eraser-mask" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white" />` +
    `<path id="np-eraser-path" fill="none" stroke="black" stroke-width="160" stroke-linecap="round" stroke-linejoin="round" />` +
    `</mask></defs>`;
  const content = document.querySelector('.np-card-content');
  if (content) { content.style.mask = 'url(#np-eraser-mask)'; content.style.webkitMask = 'url(#np-eraser-mask)'; }
}

// Diagonal scribble eraser path, swept to cover any width.
function getPlayerEraserPath(W, H, P) {
  if (playerEraserPts) return playerEraserPts;
  playerEraserPts = [];
  const startX = -P - 80, startY = -P - 80;
  const maxDim = Math.max(W, H) + P * 2 + 160;

  const basePts = [];
  const zigzags = 24;
  for (let i = 0; i <= zigzags; i++) {
    let t = i / zigzags;
    let bx = startX + t * maxDim;
    let by = startY + t * maxDim;
    let offset = (i % 2 === 0) ? 1 : -1;
    let amp = 550 + Math.random() * 50;
    if (i === 0 || i === zigzags) amp = 0;
    let px = 0.707, py = -0.707;
    basePts.push({ x: bx + px * amp * offset, y: by + py * amp * offset });
  }

  const detailSteps = 8;
  let totalLength = 0;
  for (let i = 0; i < basePts.length - 1; i++) {
    let p1 = basePts[i], p2 = basePts[i + 1];
    for (let j = 0; j < detailSteps; j++) {
      let t = j / detailSteps;
      let x = p1.x + (p2.x - p1.x) * t + (Math.random() - 0.5) * 15;
      let y = p1.y + (p2.y - p1.y) * t + (Math.random() - 0.5) * 15;
      let pt = { x, y };
      if (playerEraserPts.length > 0) {
        let lastPt = playerEraserPts[playerEraserPts.length - 1];
        totalLength += Math.hypot(x - lastPt.x, y - lastPt.y);
      }
      pt.dist = totalLength;
      playerEraserPts.push(pt);
    }
  }
  let lastBase = basePts[basePts.length - 1];
  totalLength += Math.hypot(lastBase.x - playerEraserPts[playerEraserPts.length - 1].x, lastBase.y - playerEraserPts[playerEraserPts.length - 1].y);
  playerEraserPts.push({ x: lastBase.x, y: lastBase.y, dist: totalLength });
  playerEraserPts.totalLength = totalLength;
  return playerEraserPts;
}

const NP_STROKE_DUR = 1200, NP_FADE_DELAY = 300, NP_FADE_DUR = 500;
const NP_TOTAL = Math.max(NP_STROKE_DUR, NP_FADE_DELAY + NP_FADE_DUR), NP_OUTRO = 1500;

// One rAF loop, started once, drives the begin/end animation off playerAnimState.
function playerBorderTick(ts) {
  requestAnimationFrame(playerBorderTick);
  const pb = playerBorder;
  if (!pb) return;
  const ctx = pb.ctx;
  const contentEl = document.querySelector('.np-card-content');
  let elapsed = ts - playerAnimStart;

  if (playerAnimState === 'DISAPPEARING' && elapsed >= NP_OUTRO) {
    playerAnimState = 'HIDDEN';
    pb.seed = Math.random() * 1000;
    playerEraserPts = null;
  }

  ctx.clearRect(-50, -50, pb.cw + 100, pb.ch + 100);

  if (playerAnimState === 'HIDDEN') {
    if (contentEl) contentEl.style.opacity = 0;
    const ep = document.getElementById('np-eraser-path');
    if (ep) ep.setAttribute('d', '');
    return;
  }

  ctx.save();
  ctx.translate(pb.P, pb.P);
  const deformed = boilDeformPath(pb.basePath, ts / 1000, pb.seed);
  ctx.lineWidth = BOIL_CFG.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (playerAnimState === 'APPEARING') {
    if (elapsed >= NP_TOTAL) { playerAnimState = 'VISIBLE'; elapsed = NP_TOTAL; }
    const strokeT = Math.min(1, Math.max(0, elapsed / NP_STROKE_DUR));
    const strokeProgress = 1 - Math.pow(1 - strokeT, 3); // ease-out
    const fadeT = Math.min(1, Math.max(0, (elapsed - NP_FADE_DELAY) / NP_FADE_DUR));
    const smoothFade = fadeT * fadeT * (3 - 2 * fadeT);

    if (strokeProgress < 1) {
      // progressive line-draw: a single dash longer than the path, revealed by offset
      const perim = (pb.contentW + pb.contentH) * 2.5;
      ctx.setLineDash([perim, perim]);
      ctx.lineDashOffset = perim * (1 - strokeProgress);
    } else {
      ctx.setLineDash([]);
    }

    ctx.fillStyle = `rgba(255,255,255,${smoothFade})`;
    boilTraceSmoothPath(ctx, deformed); ctx.fill();
    if (contentEl) contentEl.style.opacity = smoothFade;
    ctx.strokeStyle = '#000000';
    boilTraceSmoothPath(ctx, deformed); ctx.stroke();
  } else { // VISIBLE or DISAPPEARING
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    boilTraceSmoothPath(ctx, deformed); ctx.fill();
    ctx.strokeStyle = '#000000';
    boilTraceSmoothPath(ctx, deformed); ctx.stroke();
    if (contentEl && contentEl.style.opacity !== '1') contentEl.style.opacity = 1;

    if (playerAnimState === 'DISAPPEARING') {
      const outroP = Math.max(0, Math.min(1, elapsed / NP_OUTRO));
      const easeP = outroP < 0.5 ? 2 * outroP * outroP : 1 - Math.pow(-2 * outroP + 2, 2) / 2;
      const pts = getPlayerEraserPath(pb.contentW, pb.contentH, pb.P);
      const targetDist = easeP * pts.totalLength;
      let d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].dist <= targetDist) { d += ` L ${pts[i].x} ${pts[i].y}`; }
        else {
          const prev = pts[i - 1], cur = pts[i], seg = cur.dist - prev.dist;
          if (seg > 0) { const t = (targetDist - prev.dist) / seg; d += ` L ${prev.x + (cur.x - prev.x) * t} ${prev.y + (cur.y - prev.y) * t}`; }
          break;
        }
      }
      const ep = document.getElementById('np-eraser-path');
      if (ep) { ep.setAttribute('d', d); ep.setAttribute('transform', `translate(${(Math.random() - 0.5) * 2},${(Math.random() - 0.5) * 2})`); }
      // erase the border canvas too (the mask handles the content)
      ctx.globalCompositeOperation = 'destination-out';
      const p2d = new Path2D(d);
      ctx.save();
      ctx.translate((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
      ctx.lineWidth = 140; ctx.stroke(p2d);
      ctx.lineWidth = 160; ctx.stroke(p2d);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.restore();
}

// Show the player when a song is playing/buffering; hide (debounced) when it
// stops — same trigger timing as the widget.
let playerHideTimer = null;
function handlePlayerVisibility(visible) {
  clearTimeout(playerHideTimer);
  if (visible) setPlayerVisibility(true);
  else playerHideTimer = setTimeout(() => setPlayerVisibility(false), 400);
}

// The queues as last rendered — used by the bulk Accept-all / Remove-all buttons.
let currentReview = [];
let currentPlay = [];

function render(s) {
  currentReview = s.reviewQueue || [];
  currentPlay = s.playQueue || [];
  renderList(ui.reviewList, ui.reviewEmpty, currentReview, 'review');
  renderList(ui.playList, ui.playEmpty, currentPlay, 'play');
  updateNowPlaying(s.nowPlaying || null);
  // Mods see a banner when the host is offline; the host never shows it.
  ui.offlineBanner.classList.toggle('hidden', role === 'host' || !!s.hostConnected);
}

// Keyed reconciliation: reuse existing card elements across renders so their
// boiling-border animation keeps running. Only build new cards and drop gone
// ones — re-appending an existing element just reorders it (no rebuild).
const cardCache = { review: new Map(), play: new Map() };

function renderList(listEl, emptyEl, items, column) {
  const cache = cardCache[column];
  const seen = new Set();
  items.forEach((item, i) => {
    seen.add(item.id);
    let card = cache.get(item.id);
    if (!card) { card = buildCard(item, column); cache.set(item.id, card); }
    // Only touch the DOM when this card isn't already in the right slot — avoids
    // re-appending every card each render (which churns layout + disturbs clicks).
    if (listEl.children[i] !== card) listEl.insertBefore(card, listEl.children[i] || null);
    if (!card._bordersReady) setupCardBorders(card); // (re)try until it has a size
  });
  for (const [id, card] of cache) {
    if (!seen.has(id)) { unregisterCardBorders(card); card.remove(); cache.delete(id); }
  }
  emptyEl.classList.toggle('hidden', items.length > 0);
}

// Re-measure all card borders after web fonts load and on resize (their pixel
// sizes change, and the boiling canvas is sized to the measured box).
let _resizeTimer = null;
function resizeAllCardBorders() {
  for (const cache of [cardCache.review, cardCache.play]) {
    for (const card of cache.values()) if (card.isConnected) setupCardBorders(card);
  }
  setupPlayerBorder();
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { resizeAllCardBorders(); fitViewTitle(); });
window.addEventListener('resize', () => {
  fitViewTitle();
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(resizeAllCardBorders, 150);
});

/* =============================================================================
 *  TOOLBAR — theme toggle, view toggle, bulk Accept-all / Decline-all
 * ========================================================================== */

// Light/dark only affects the toolbar foreground + the page background.
// Icon shown: sun in light mode, moon in dark mode (per the design).
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.body.classList.toggle('dark', dark);
  const icon = dark ? '/icons/moon.svg' : '/icons/sun.svg';
  if (ui.themeToggleIcon) ui.themeToggleIcon.src = icon;     // queue toolbar
  if (ui.topThemeIcon) ui.topThemeIcon.src = icon;           // pre-queue top bar
}
function toggleTheme() {
  const next = document.body.classList.contains('dark') ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// 'requests' shows the review queue; 'queue' shows the approved play queue.
let currentView = 'requests';
function setView(view) {
  currentView = view;
  const requests = view === 'requests';
  ui.requestsView.classList.toggle('hidden', !requests);
  ui.queueView.classList.toggle('hidden', requests);
  ui.viewTitle.innerHTML = requests
    ? '<span class="view-opt">SONG&nbsp;</span><span class="view-main">REQUESTS</span>'
    : '<span class="view-opt">SONG&nbsp;</span><span class="view-main">QUEUE</span>';
  // the view-toggle icon shows the OTHER view (where the click takes you)
  ui.viewToggleIcon.src = requests ? '/icons/queue-list.svg' : '/icons/request-list.svg';
  // Accept-all is requests-only, but we keep its slot reserved (just invisible)
  // in the queue view so the toolbar layout — and therefore the title's available
  // width — stays identical between views. The broom shows in both views.
  ui.acceptAllBtn.classList.remove('hidden');
  ui.acceptAllBtn.style.visibility = requests ? '' : 'hidden';
  ui.declineAllBtn.classList.remove('hidden');
  fitViewTitle(); // drop the "SONG " part if the full title won't fit
  // Cards built while their view was hidden have zero size, so their boiling
  // borders weren't registered — set them up now that the view is visible.
  resizeAllCardBorders();
}

// Show the full "SONG REQUESTS" / "SONG QUEUE" when it fits, otherwise drop the
// "SONG " part (rather than clipping mid-word). The decision is always made
// against the LONGER title ("REQUESTS") so both views shorten together.
function fitViewTitle() {
  const opt = ui.viewTitle.querySelector('.view-opt');
  const main = ui.viewTitle.querySelector('.view-main');
  if (!opt || !main) return;
  opt.style.display = '';
  const realMain = main.textContent;
  if (realMain !== 'REQUESTS') main.textContent = 'REQUESTS'; // measure the worst case
  const needed = opt.scrollWidth + main.scrollWidth;
  const fits = needed <= ui.viewTitle.clientWidth;
  if (main.textContent !== realMain) main.textContent = realMain; // restore
  opt.style.display = fits ? '' : 'none';
}

// Bulk actions run the normal per-item action for every request (snapshot first,
// since the host mutates the queue as each one is applied).
function acceptAll() { for (const item of currentReview.slice()) onAction('accept', item.id); }
// The broom clears whichever list is currently shown.
function declineAll() {
  const list = currentView === 'queue' ? currentPlay : currentReview;
  for (const item of list.slice()) onAction('decline', item.id);
}

function initToolbar() {
  ui.themeToggleBtn.addEventListener('click', toggleTheme);
  ui.viewToggleBtn.addEventListener('click', () => setView(currentView === 'requests' ? 'queue' : 'requests'));
  ui.acceptAllBtn.addEventListener('click', acceptAll);
  ui.declineAllBtn.addEventListener('click', declineAll);
  setView('requests');
}

/* ---------------------------------------------------------------------------
 *  BOILING BORDER — animated wobbling outline, ported verbatim from the
 *  MultichatOverlay. A single rAF loop redraws every registered card canvas;
 *  disconnected canvases drop out automatically.
 * ------------------------------------------------------------------------- */
const Simplex3D = (function () {
  const F3 = 1.0 / 3.0, G3 = 1.0 / 6.0;
  const p = new Uint8Array([151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180]);
  const perm = new Uint8Array(512), permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = (perm[i] % 12); }
  function grad(hash, x, y, z) {
    const h = hash & 15; const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }
  return function (xin, yin, zin) {
    let n0, n1, n2, n3;
    const s = (xin + yin + zin) * F3; const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3; const X0 = i - t, Y0 = j - t, Z0 = k - t;
    const x0 = xin - X0, y0 = yin - Y0, z0 = zin - Z0;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=1;k2=0; } else if (x0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=0;k2=1; } else { i1=0;j1=0;k1=1;i2=1;j2=0;k2=1; }
    } else {
      if (y0 < z0) { i1=0;j1=0;k1=1;i2=0;j2=1;k2=1; } else if (x0 < z0) { i1=0;j1=1;k1=0;i2=0;j2=1;k2=1; } else { i1=0;j1=1;k1=0;i2=1;j2=1;k2=0; }
    }
    const x1=x0-i1+G3, y1=y0-j1+G3, z1=z0-k1+G3;
    const x2=x0-i2+2.0*G3, y2=y0-j2+2.0*G3, z2=z0-k2+2.0*G3;
    const x3=x0-1.0+3.0*G3, y3=y0-1.0+3.0*G3, z3=z0-1.0+3.0*G3;
    const ii=i&255, jj=j&255, kk=k&255;
    let t0=0.6-x0*x0-y0*y0-z0*z0; if(t0<0) n0=0.0; else { t0*=t0; n0=t0*t0*grad(permMod12[ii+perm[jj+perm[kk]]],x0,y0,z0); }
    let t1=0.6-x1*x1-y1*y1-z1*z1; if(t1<0) n1=0.0; else { t1*=t1; n1=t1*t1*grad(permMod12[ii+i1+perm[jj+j1+perm[kk+k1]]],x1,y1,z1); }
    let t2=0.6-x2*x2-y2*y2-z2*z2; if(t2<0) n2=0.0; else { t2*=t2; n2=t2*t2*grad(permMod12[ii+i2+perm[jj+j2+perm[kk+k2]]],x2,y2,z2); }
    let t3=0.6-x3*x3-y3*y3-z3*z3; if(t3<0) n3=0.0; else { t3*=t3; n3=t3*t3*grad(permMod12[ii+1+perm[jj+1+perm[kk+1]]],x3,y3,z3); }
    return 32.0*(n0+n1+n2+n3);
  };
})();

const BOIL_CFG = { cornerRadius: 20, strokeWidth: 7, noiseFreq: 4.2, noiseCoordScale: 0.006, noiseTimeScale: 1.0, noiseAmp: 1.5, divW: 200, divH: 60, divCorner: 10, padding: 10 };
function boilBuildBasePath(W, H, R) {
  const pts = []; const { divW, divH, divCorner } = BOIL_CFG;
  for (let i=0; i<divW; i++) pts.push({ x: R+(W-2*R)*(i/divW), y: 0 });
  for (let i=0; i<divCorner; i++) pts.push({ x: W-R+R*Math.cos(-Math.PI/2+(Math.PI/2)*(i/divCorner)), y: R+R*Math.sin(-Math.PI/2+(Math.PI/2)*(i/divCorner)) });
  for (let i=0; i<divH; i++) pts.push({ x: W, y: R+(H-2*R)*(i/divH) });
  for (let i=0; i<divCorner; i++) pts.push({ x: W-R+R*Math.cos((Math.PI/2)*(i/divCorner)), y: H-R+R*Math.sin((Math.PI/2)*(i/divCorner)) });
  for (let i=0; i<divW; i++) pts.push({ x: W-R-(W-2*R)*(i/divW), y: H });
  for (let i=0; i<divCorner; i++) pts.push({ x: R+R*Math.cos(Math.PI/2+(Math.PI/2)*(i/divCorner)), y: H-R+R*Math.sin(Math.PI/2+(Math.PI/2)*(i/divCorner)) });
  for (let i=0; i<divH; i++) pts.push({ x: 0, y: H-R-(H-2*R)*(i/divH) });
  for (let i=0; i<divCorner; i++) pts.push({ x: R+R*Math.cos(Math.PI+(Math.PI/2)*(i/divCorner)), y: R+R*Math.sin(Math.PI+(Math.PI/2)*(i/divCorner)) });
  return pts;
}
function boilDeformPath(base, time, seed) {
  const freq = BOIL_CFG.noiseFreq * BOIL_CFG.noiseCoordScale, t = time * BOIL_CFG.noiseTimeScale;
  return base.map(p => ({ x: p.x + Simplex3D(p.x*freq+seed, p.y*freq+seed, t) * BOIL_CFG.noiseAmp, y: p.y + Simplex3D(p.x*freq+seed+99.9, p.y*freq+seed+99.9, t) * BOIL_CFG.noiseAmp }));
}
function boilTraceSmoothPath(c, pts) {
  if (pts.length < 3) return; c.beginPath(); let p1 = pts[0]; c.moveTo((pts[pts.length-1].x+p1.x)/2, (pts[pts.length-1].y+p1.y)/2);
  for (let i=0; i<pts.length; i++) { p1 = pts[i]; const p2 = pts[(i+1)%pts.length]; c.quadraticCurveTo(p1.x, p1.y, (p1.x+p2.x)/2, (p1.y+p2.y)/2); }
  c.closePath();
}

// Registry of card canvases + one shared animation loop.
const boilEntries = new Set();
function registerBoil(canvas, contentW, contentH, bottomExtension, strokeColor) {
  unregisterBoil(canvas);
  const P = BOIL_CFG.padding, R = BOIL_CFG.cornerRadius;
  const cw = contentW + P * 2, ch = contentH + P * 2 + bottomExtension;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = cw * ratio; canvas.height = ch * ratio;
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const entry = { canvas, ctx, P, cw, ch, seed: Math.random() * 1000, stroke: strokeColor || '#000000', basePath: boilBuildBasePath(contentW, contentH + bottomExtension, R) };
  canvas._boilEntry = entry;
  boilEntries.add(entry);
}
function unregisterBoil(canvas) {
  if (canvas && canvas._boilEntry) { boilEntries.delete(canvas._boilEntry); canvas._boilEntry = null; }
}
function unregisterCardBorders(card) { card.querySelectorAll('canvas').forEach(unregisterBoil); }

// Measure a card's two boxes and (re)register their boiling canvases. The header
// border extends 26px down so it visually connects with the music card below.
function setupCardBorders(card) {
  const headerWrap = card.querySelector('.sub-card-wrapper');
  if (!headerWrap || headerWrap.offsetWidth === 0) return; // hidden — retried later
  registerBoil(card.querySelector('.sub-border-canvas'), headerWrap.offsetWidth, headerWrap.offsetHeight, 26, '#000000');
  const commentWrap = card.querySelector('.sub-comment-wrapper');
  if (commentWrap) registerBoil(card.querySelector('.sub-comment-border-canvas'), commentWrap.offsetWidth, commentWrap.offsetHeight, 0, '#000000');
  card._bordersReady = true;
}

function boilTick(ts) {
  for (const e of boilEntries) {
    if (!e.canvas.isConnected) { boilEntries.delete(e); continue; }
    const ctx = e.ctx;
    ctx.clearRect(0, 0, e.cw, e.ch);
    ctx.save();
    ctx.translate(e.P, e.P);
    const deformed = boilDeformPath(e.basePath, ts / 1000, e.seed);
    ctx.fillStyle = '#ffffff';
    boilTraceSmoothPath(ctx, deformed); ctx.fill();
    ctx.strokeStyle = e.stroke; ctx.lineWidth = BOIL_CFG.strokeWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    boilTraceSmoothPath(ctx, deformed); ctx.stroke();
    ctx.restore();
  }
  requestAnimationFrame(boilTick);
}
requestAnimationFrame(boilTick);

/* ---------------------------------------------------------------------------
 *  Card header helpers (avatar, channel-point icon, timestamp)
 * ------------------------------------------------------------------------- */
// Twitch avatar via decapi (no key); dicebear fallback for unknown users.
const avatarCache = new Map();
async function GetAvatar(username) {
  if (username && avatarCache.has(username)) return avatarCache.get(username);
  if (username) {
    try {
      const r = await fetch('https://decapi.me/twitch/avatar/' + encodeURIComponent(username));
      if (r.ok) { const t = (await r.text()).trim(); if (t.startsWith('http')) { avatarCache.set(username, t); return t; } }
    } catch (_) {}
  }
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(username || 'anon')}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
}

// Outline an icon (white silhouette ring) so it reads on the white card. Ported
// from the overlay; used for the channel-point cost icon in the description.
const _outlineCache = new Map();
function makeOutlinedIcon(srcUrl, outlinePx = 5, outlineColor = '#000') {
  const key = `${srcUrl}|${outlinePx}|${outlineColor}`;
  if (_outlineCache.has(key)) return _outlineCache.get(key);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight, pad = outlinePx + 2;
      const cw = w + pad * 2, ch = h + pad * 2;
      const sil = document.createElement('canvas'); sil.width = cw; sil.height = ch;
      const sx = sil.getContext('2d');
      sx.drawImage(img, pad, pad, w, h);
      sx.globalCompositeOperation = 'source-in';
      sx.fillStyle = outlineColor; sx.fillRect(0, 0, cw, ch);
      const out = document.createElement('canvas'); out.width = cw; out.height = ch;
      const ox = out.getContext('2d');
      for (let a = 0; a < 360; a += 12) ox.drawImage(sil, Math.round(Math.cos(a*Math.PI/180)*outlinePx), Math.round(Math.sin(a*Math.PI/180)*outlinePx));
      ox.drawImage(img, pad, pad, w, h);
      try { resolve(out.toDataURL()); } catch (_) { resolve(srcUrl); }
    };
    img.onerror = () => resolve(srcUrl);
    img.src = srcUrl;
  });
  _outlineCache.set(key, promise);
  return promise;
}

// Compact "time since requested" like 5s / 3m / 2h / 1d.
function formatAge(ts) {
  const s = Math.max(0, Math.floor((Date.now() - (ts || Date.now())) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}
// Keep the age labels ticking up while cards stay on screen (once a second).
setInterval(() => {
  document.querySelectorAll('.sc-age-text').forEach((el) => {
    if (el.dataset.ts) el.textContent = formatAge(Number(el.dataset.ts));
  });
}, 1000);

const BLANK_PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Build one "redeemed song request" card (returns the element). Text is filled
// synchronously; avatar + cost icon load in async without changing the layout.
function buildCard(item, column) {
  const card = ui.songCardTemplate.content.firstElementChild.cloneNode(true);

  // --- header ---
  card.querySelector('.sc-username').textContent = item.user || 'someone';

  // age ("3m") — ticks up via the interval above
  const ageEl = card.querySelector('.sc-age-text');
  const created = item.createdAt || Date.now();
  ageEl.textContent = formatAge(created);
  ageEl.dataset.ts = created;

  const avatarSpan = card.querySelector('.sc-avatar');
  GetAvatar(item.user).then((url) => { avatarSpan.innerHTML = `<img class="avatar" src="${url}" alt="" />`; });

  // --- music card ---
  const art = card.querySelector('.sc-art');
  art.src = item.albumArt || BLANK_PX;
  art.onerror = () => { art.src = BLANK_PX; };

  card.querySelector('.sc-title').textContent = item.title || item.query || '(unknown)';
  const albumEl = card.querySelector('.sc-album');
  if (item.album) albumEl.textContent = item.album; else albumEl.remove();
  card.querySelector('.sc-artist').textContent = item.artist || '';

  const durationEl = card.querySelector('.sc-duration');
  if (item.durationMs) card.querySelector('.sc-duration-text').textContent = FormatSongDuration(item.durationMs);
  else durationEl.remove();

  if (item.playable === false) {
    card.classList.add('unplayable');
    card.querySelector('.sc-warn').classList.remove('hidden');
  }

  // --- header action icons (left→right: accept, decline, force) ---
  const actions = card.querySelector('.sc-actions');
  const iconBtn = (icon, type, label) => {
    const b = document.createElement('button');
    b.className = 'sc-icon-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<img src="/icons/${icon}" alt="" />`;
    b.addEventListener('click', () => onAction(type, item.id));
    return b;
  };
  // Copy the request as "Title by Artist" so the streamer can paste it into a
  // search. Offered on unplayable cards where there's no one-click play.
  const copyBtn = () => {
    const b = document.createElement('button');
    b.className = 'sc-icon-btn';
    b.title = 'Copy “Title by Artist”';
    b.setAttribute('aria-label', 'Copy song');
    b.innerHTML = `<img src="/icons/copy.svg" alt="" />`;
    b.addEventListener('click', () => {
      const text = item.artist ? `${item.title} by ${item.artist}` : (item.title || item.query || '');
      copyToClipboard(text);
      b.title = 'Copied!';
      setTimeout(() => { b.title = 'Copy “Title by Artist”'; }, 1500);
    });
    return b;
  };
  if (column === 'review') {
    if (item.playable === false) {
      // Unplayable: no play — offer copy ("Title by Artist") + remove on the right.
      actions.appendChild(iconBtn('trash-can.svg', 'decline', 'Remove'));
      actions.appendChild(copyBtn());
    } else {
      actions.appendChild(iconBtn('accept.svg', 'accept', 'Accept'));
      actions.appendChild(iconBtn('decline.svg', 'decline', 'decline'));
      actions.appendChild(iconBtn('accept-force.svg', 'force', 'Force'));
    }
  } else {
    // Queue (left→right): move up, move down, remove, play now.
    actions.appendChild(iconBtn('move-up.svg', 'moveup', 'Move up'));
    actions.appendChild(iconBtn('move-down.svg', 'movedown', 'Move down'));
    actions.appendChild(iconBtn('trash-can.svg', 'decline', 'Remove'));
    actions.appendChild(iconBtn('accept-force.svg', 'force', 'Play now'));
  }

  return card;
}

// Route a button press: the host acts locally; a mod asks the server.
function onAction(type, id) {
  if (role === 'host') hostApplyAction(type, id);
  else sendModAction(type, id);
}

// Copy text to the clipboard, with a fallback for older/insecure contexts.
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  ta.remove();
}

/* =============================================================================
 *  NOW-PLAYING BAR — smooth progress, interpolated between state updates
 *  (same approach as the existing widget: tick locally, re-sync on updates).
 * ========================================================================== */
const np = { secs: 0, dur: 0, playing: false, last: performance.now(), vid: null, scrollStart: null };

function updateNowPlaying(n) {
  if (!n) {
    if (np.vid !== null) { ui.npTitle.textContent = ''; ui.npArtist.textContent = ''; ui.npArt.src = BLANK_PX; }
    np.playing = false; np.secs = 0; np.dur = 0; np.vid = null; np.scrollStart = null;
    handlePlayerVisibility(false); // nothing playing → animate the player out
    return;
  }

  const songChanged = n.videoId !== np.vid;
  if (songChanged) {
    np.vid = n.videoId;
    ui.npTitle.textContent = n.title || '';
    ui.npArtist.textContent = n.artist || '';
    ui.npArt.src = n.albumArt || BLANK_PX;
    np.scrollStart = null; // restart the title/artist scroll for the new song
  }

  np.dur = n.durationSeconds || 0;
  const wasPlaying = np.playing;
  np.playing = n.trackState === 1;

  // Show the player while playing(1)/buffering(2); animate it out otherwise.
  handlePlayerVisibility(n.trackState === 1 || n.trackState === 2);

  // Re-sync our local clock to the server progress on song/state change or drift.
  const serverSecs = n.progress || 0;
  let localSecs = np.secs;
  if (wasPlaying) localSecs += (performance.now() - np.last) / 1000;
  if (songChanged || np.playing !== wasPlaying || Math.abs(serverSecs - localSecs) > 2) {
    np.secs = serverSecs;
    np.last = performance.now();
  }
}

// Title/artist horizontal scroll when they overflow (ported from the widget):
// pause, ease-scroll to the end, pause, snap back. `syncOverflow` keeps the
// title and artist scrolling on the same clock so they line up.
function getScrollOffset(overflow, syncOverflow, timeMs) {
  if (overflow <= 0) return 0;
  const speed = 40;
  const scrollDur = (syncOverflow / speed) * 1000;
  const myScrollDur = (overflow / speed) * 1000;
  const pauseStart = 6000, pauseEnd = 6000;
  const totalCycle = pauseStart + scrollDur + pauseEnd;
  const t = timeMs % totalCycle;
  if (t < pauseStart) return 0;
  if (t >= pauseStart + scrollDur) return -overflow;
  const scrollTime = t - pauseStart;
  if (scrollTime >= myScrollDur) return -overflow;
  const p = scrollTime / myScrollDur;
  const ease = -(Math.cos(Math.PI * p) - 1) / 2;
  return -(ease * overflow);
}

// rAF loop: interpolate progress, scroll the text, and draw the animated
// sine-wave progress line + thumb — all 1:1 with the widget.
function tickPlayer(ts) {
  if (np.scrollStart === null) np.scrollStart = ts;
  const timeMs = ts - np.scrollStart;

  const titleEl = ui.npTitle, artistEl = ui.npArtist;
  const titleOverflow = Math.max(0, titleEl.scrollWidth - titleEl.parentElement.clientWidth);
  const artistOverflow = Math.max(0, artistEl.scrollWidth - artistEl.parentElement.clientWidth);
  const maxOverflow = Math.max(titleOverflow, artistOverflow);
  titleEl.style.transform = `translateX(${getScrollOffset(titleOverflow, maxOverflow, timeMs)}px)`;
  artistEl.style.transform = `translateX(${getScrollOffset(artistOverflow, maxOverflow, timeMs)}px)`;

  let secs = np.secs;
  if (np.playing && np.dur > 0) secs += (performance.now() - np.last) / 1000;
  secs = Math.max(0, Math.min(np.dur || secs, secs));
  const remaining = Math.max(0, np.dur - secs);
  const progress = np.dur > 0 ? secs / np.dur : 0;

  ui.npCurrent.textContent = ConvertSeconds(secs);
  ui.npDuration.textContent = np.dur > 0 ? '-' + ConvertSeconds(remaining) : '-0:00';

  const container = ui.npProgressContainer;
  if (container) {
    const thumbX = progress * container.clientWidth;
    ui.npThumb.style.left = thumbX + 'px';
    ui.npProgressSvg.style.width = Math.max(0, thumbX + 10) + 'px';
    let d = 'M 0 12';
    if (thumbX > 0) {
      const segments = Math.max(10, Math.floor(thumbX / 2));
      d = '';
      for (let i = 0; i <= segments; i++) {
        const px = (i / segments) * thumbX;
        const py = 12 + Math.sin((px * 0.15) + (timeMs * 0.004)) * 1.5;
        d += (i === 0 ? 'M ' : ' L ') + px + ' ' + py;
      }
    }
    ui.npProgressPath.setAttribute('d', d);
  }

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
 *    1. Our OWN server's /resolve endpoint (default, zero-config). The browser
 *       can't query YouTube across origins, so the Node server does the search
 *       server-side (no CORS there) and returns the videoId. Same-origin call —
 *       no third-party proxy involved. See /resolve in server.js.
 *    2. YouTube Data API v3 — fallback, only if you supply a key (?ytKey=... once,
 *       or localStorage 'srq_yt_api_key'). Google's API sends CORS headers so the
 *       browser can call it directly. Restrict the key to your app domain.
 *
 *  Returns an 11-char videoId string, or null if nothing could be resolved
 *  (the item is still queued, just flagged not-playable).
 * ========================================================================== */
async function ResolveYouTubeVideoId(title, artist) {
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) return null;

  // --- Strategy 1: ask our own server (same-origin, no CORS, no proxy) -------
  try {
    const r = await fetch(`${SERVER}/resolve?q=` + encodeURIComponent(query));
    if (r.ok) {
      const j = await r.json();
      if (j.videoId) return j.videoId;
    }
  } catch (e) { console.debug('[videoId] server resolve failed, trying fallback', e); }

  // --- Strategy 2: YouTube Data API v3 (only if a key is configured) ---------
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
    } catch (e) { console.debug('[videoId] Data API failed', e); }
  }

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

  let info, artCandidates;
  if (seed.authoritative) {
    // Authoritative seeds (e.g. Spotify embeds) keep their title/artist, but we enrich the album/art.
    artCandidates = [seed.albumArt, itunes && itunes.albumArt, mb && mb.albumArt];
    const resolvedArt = await ResolveAlbumArt(artCandidates);

    // Match the album name to whichever service provided the working art (fallback to iTunes then MB)
    let album = '';
    if (resolvedArt && itunes && resolvedArt === itunes.albumArt) album = itunes.album;
    else if (resolvedArt && mb && resolvedArt === mb.albumArt) album = mb.album;
    else album = (itunes || mb || {}).album || '';

    info = { 
      title: seed.title, 
      artist: seed.artist, 
      album, 
      durationMs: seed.durationMs || (itunes || mb || {}).durationMs || 0, 
      albumArt: resolvedArt 
    };
  } else {
    // Non-authoritative: we want the text to perfectly match the artwork we end up displaying.
    artCandidates = [itunes && itunes.albumArt, mb && mb.albumArt, seed.albumArt];
    const resolvedArt = await ResolveAlbumArt(artCandidates);

    let bestSource = null;
    if (resolvedArt) {
      if (itunes && resolvedArt === itunes.albumArt) bestSource = itunes;
      else if (mb && resolvedArt === mb.albumArt) bestSource = mb;
    }
    // If the artwork didn't come from iTunes or MB (or no art loaded), default to iTunes then MB text.
    if (!bestSource) bestSource = itunes || mb || {};

    info = bestSource.title
      ? { title: bestSource.title, artist: bestSource.artist, album: bestSource.album || '', durationMs: bestSource.durationMs || 0, albumArt: resolvedArt }
      : { title: seed.title, artist: seed.artist, album: '', durationMs: 0, albumArt: resolvedArt };
  }
  
  return info;
}