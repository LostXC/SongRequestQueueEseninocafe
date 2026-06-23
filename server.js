/**
 * Eseninocafe Song Request Queue — sync server
 * =============================================
 *
 * This server is intentionally DUMB. It holds no business logic about songs or
 * YouTube Music. Its only jobs are:
 *
 *   1. Serve the single web page (public/).
 *   2. Hold the queue state IN MEMORY (no database).
 *   3. Fan that state out to every connected browser over SSE.
 *   4. Accept authoritative state pushes from the HOST tab (the streamer's PC).
 *   5. Queue up mod actions (accept / force / decline) and hand them to the host.
 *
 * The host tab is the single source of truth. It is the only thing that talks to
 * YouTube Music Desktop and Streamer.bot (both on localhost). The server CANNOT
 * reach the streamer's localhost, so it never tries to control playback — it only
 * relays. See README.md for the full picture.
 *
 * Config comes from environment variables (Render) or a local config.json:
 *   MOD_CODE     — the shared code mods type to view/act on the queue.
 *   HOST_SECRET  — secret only the streamer's host tab knows; gates state pushes.
 *   PORT         — port to listen on (Render sets this automatically).
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config: env vars win; fall back to a local config.json for development.
// ---------------------------------------------------------------------------
let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (_) {
  /* no config.json — that's fine, we'll use env vars / defaults */
}

const MOD_CODE = process.env.MOD_CODE || fileConfig.MOD_CODE || 'changeme';
const HOST_SECRET = process.env.HOST_SECRET || fileConfig.HOST_SECRET || 'host-secret-changeme';
const PORT = process.env.PORT || fileConfig.PORT || 3000;

// How long (ms) without a host heartbeat before we consider the host offline.
const HOST_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// In-memory state. Wiped on every restart — that's intended; the host re-pushes
// its authoritative state as soon as it reconnects.
// ---------------------------------------------------------------------------
const state = {
  // Items awaiting a mod decision. Each item:
  //   { id, user, query, videoId, playable, title, artist, album,
  //     durationMs, albumArt, createdAt }
  reviewQueue: [],
  // Approved items waiting to play, in order.
  playQueue: [],
  // Mirror of what the host reports from YouTube Music, or null.
  //   { title, artist, album, albumArt, videoId, durationSeconds, progress,
  //     trackState, updatedAt }
  nowPlaying: null,
};

let hostConnected = false;
let lastHostBeat = 0;

// Mod actions waiting for the host to pick up and execute. Each:
//   { actionId, type: 'accept'|'force'|'decline', id }
let pendingActions = [];

// Active viewer session tokens (mods who entered the correct code).
const sessions = new Set();

// Connected SSE clients (mod browsers + the host's own viewer panel).
const sseClients = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicState() {
  return {
    reviewQueue: state.reviewQueue,
    playQueue: state.playQueue,
    nowPlaying: state.nowPlaying,
    hostConnected,
  };
}

// Push the current full state to every connected SSE client.
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      /* dead connection; it'll be cleaned up on 'close' */
    }
  }
}

// Pull the bearer token out of an Authorization header.
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Mod login: exchange the shared MOD_CODE for a session token. -----------
app.post('/login', (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || code !== MOD_CODE) {
    return res.status(401).json({ error: 'Invalid code' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.json({ token });
});

// --- SSE stream: every browser (mods + host panel) subscribes here. ---------
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Tell intermediary proxies (Render's included) not to buffer the stream,
    // otherwise SSE events can arrive in batches or stall.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // Send the current state immediately so a fresh tab isn't blank.
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// --- Host pushes authoritative state up here. Gated by HOST_SECRET. ---------
app.post('/host/sync', (req, res) => {
  if (bearer(req) !== HOST_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { reviewQueue, playQueue, nowPlaying } = req.body || {};
  if (Array.isArray(reviewQueue)) state.reviewQueue = reviewQueue;
  if (Array.isArray(playQueue)) state.playQueue = playQueue;
  if (nowPlaying !== undefined) state.nowPlaying = nowPlaying;

  // A sync also counts as a heartbeat.
  hostConnected = true;
  lastHostBeat = Date.now();

  broadcast();
  res.json({ ok: true });
});

// --- Host heartbeat. Lets mods know whether playback is live. ---------------
app.post('/host/hello', (req, res) => {
  if (bearer(req) !== HOST_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const wasOffline = !hostConnected;
  hostConnected = true;
  lastHostBeat = Date.now();
  if (wasOffline) broadcast();
  res.json({ ok: true });
});

// --- Host polls for queued mod actions. Returns and CLEARS them (at-most-once
//     delivery: a dropped action is safer than a double "force play"). --------
app.get('/host/actions', (req, res) => {
  if (bearer(req) !== HOST_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const actions = pendingActions;
  pendingActions = [];
  // Polling also serves as a heartbeat.
  hostConnected = true;
  lastHostBeat = Date.now();
  res.json({ actions });
});

// --- A mod requests an action. We just record it for the host to execute. ---
app.post('/action', (req, res) => {
  if (!sessions.has(bearer(req))) return res.status(401).json({ error: 'Not authenticated' });
  const { type, id } = req.body || {};
  if (!['accept', 'force', 'decline'].includes(type) || typeof id !== 'string') {
    return res.status(400).json({ error: 'Bad action' });
  }
  pendingActions.push({ actionId: crypto.randomBytes(8).toString('hex'), type, id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Resolve a song query -> a YouTube Music videoId (needed for ytmd://play/<id>).
//
// The browser can't query YouTube across origins, and public CORS proxies are
// no longer free for hosted origins. So the server does the lookup itself —
// there's no CORS server-to-server.
//
// We search YOUTUBE MUSIC (not regular YouTube) with a "songs" filter, so we get
// the actual audio track ("Get Lucky") rather than the music video ("Get Lucky
// (Official Video)"). It uses YouTube Music's PUBLIC web-client key — this is NOT
// a personal API key and needs no setup or quota — and returns the first song's id.
//
// This is the one "smart" thing the server does, and it's deliberately narrow:
// it only talks to the YT Music search endpoint and returns an id. It does not
// control YouTube Music playback — that stays entirely on the host tab.
// ---------------------------------------------------------------------------
const YTM_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';       // YT Music WEB_REMIX public key
const YTM_SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';      // search filter: songs only

// Find a watchEndpoint.videoId anywhere inside a node (DFS).
function findWatchVideoId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.watchEndpoint && obj.watchEndpoint.videoId) return obj.watchEndpoint.videoId;
  for (const k of Object.keys(obj)) {
    const hit = findWatchVideoId(obj[k]);
    if (hit) return hit;
  }
  return null;
}

// DFS for the first YT Music song row and pull its videoId + title.
function findFirstSong(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.musicResponsiveListItemRenderer) {
    const it = obj.musicResponsiveListItemRenderer;
    const vid = (it.playlistItemData && it.playlistItemData.videoId) || findWatchVideoId(it);
    const col = (it.flexColumns && it.flexColumns[0] && it.flexColumns[0].musicResponsiveListItemFlexColumnRenderer) || {};
    const title = col.text && col.text.runs && col.text.runs[0] ? col.text.runs[0].text : '';
    if (vid) return { id: vid, title };
  }
  for (const k of Object.keys(obj)) {
    const hit = findFirstSong(obj[k]);
    if (hit) return hit;
  }
  return null;
}

app.get('/resolve', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ videoId: null });
  try {
    const r = await fetch('https://music.youtube.com/youtubei/v1/search?key=' + YTM_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'US' } },
        query: q,
        params: YTM_SONGS_FILTER,
      }),
    });
    if (!r.ok) return res.json({ videoId: null });
    const hit = findFirstSong(JSON.parse(await r.text()));
    res.json({ videoId: hit ? hit.id : null, title: hit ? hit.title : null });
  } catch (e) {
    res.json({ videoId: null });
  }
});

// ---------------------------------------------------------------------------
// Host liveness watchdog: if the host stops beating, flag it offline so mods
// get the "Host offline" banner instead of silently broken buttons.
// ---------------------------------------------------------------------------
setInterval(() => {
  if (hostConnected && Date.now() - lastHostBeat > HOST_TIMEOUT_MS) {
    hostConnected = false;
    state.nowPlaying = null; // playback can't be live if the host is gone
    broadcast();
  }
}, 3000);

app.listen(PORT, () => {
  console.log(`Song request queue server listening on :${PORT}`);
  if (MOD_CODE === 'changeme' || HOST_SECRET === 'host-secret-changeme') {
    console.warn('⚠  Using default MOD_CODE / HOST_SECRET. Set real values via env vars or config.json.');
  }
});
