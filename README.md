# Eseninocafe Song Request Queue

A Twitch **channel-point song request queue** with **remote mod review** that
controls the **YouTube Music Desktop App (YTMDesktop)**.

The streamer installs **nothing**. He opens **one inspectable webpage** in a
browser tab on his streaming PC. That tab does all the real work. Mods open the
**same link** from anywhere, type a code, and review the queue. A thin
Render-hosted Node server only **syncs** the queue between the streamer's tab and
the mods — it never touches anyone's computer.

---

## How it works

```
                         Render (thin sync server, Node + Express)
                          - holds the queue in memory (no database)
                          - relays between the host tab and mods
                          - serves the single web page
                              ▲                       ▲
        host pushes queue +   │                       │  mods view queue, send
        now-playing state up  │                       │  accept / force / decline
                              │                       │
            ┌─────────────────┘                       └───────────────┐
            │                                                         │
   HOST TAB (streamer's PC)                                     MOD (any device)
   - one open browser tab                                       - opens SAME link
   - Streamer.bot   ws://127.0.0.1:8080   (hears redeems)       - enters mod code
   - YTMDesktop     http://127.0.0.1:9863 (reads + controls)    - sees queue, acts
   - fires ytmd://play/<videoId>
   - searches song metadata + a YouTube videoId
   - THIS TAB DOES ALL THE INTELLIGENT WORK
```

**Two modes, auto-detected** when the page loads:

- **Host mode** — the page tries to reach Streamer.bot (`127.0.0.1:8080`) and
  YTMDesktop (`127.0.0.1:9863`). On the streaming PC both succeed, so that tab
  becomes the **host**: it hears redeems, identifies songs, controls YouTube
  Music, and pushes the queue up to Render.
- **Viewer mode** — on a mod's device those localhost connections fail, so the
  page shows **"Enter code to access the queue."** After the correct **mod code**
  the mod sees the live queue with **Accept / Force / Decline** buttons. A mod's
  browser never touches localhost.

The **host is always the source of truth.** A mod's button press is just a
*request*: the server queues it, the host picks it up, applies it to its real
queue and to YouTube Music, then pushes the updated state back out.

> Force `?viewer` in the URL to preview viewer mode on the host PC, or `?host` to
> force host mode.

---

## What the host tab connects to (and nothing else)

The page is fully readable — open DevTools and confirm the host tab only talks to:

1. **`ws://127.0.0.1:8080`** — Streamer.bot, to hear channel-point redeems. *Local.*
2. **`http://127.0.0.1:9863`** — YTMDesktop, to read the now-playing state and
   play songs. *Local.*
3. **This page's own origin** (your app URL) — to sync the queue to mods.

Plus read-only, no-key metadata lookups to identify songs: **MusicBrainz**,
**Cover Art Archive**, **iTunes**, and a **YouTube** search (see
`ResolveYouTubeVideoId` in [`public/app.js`](public/app.js)). Nothing is
minified or obfuscated; every external connection is commented in the source.

The single shared **`MOD_CODE`** lets mods view and act. A separate
**`HOST_SECRET`** (entered once on the streaming PC, saved in that browser only)
is required to push authoritative state — so a mod can never spoof the queue.

---

## Deploy to Koyeb

This is just a Node/Express app, so any Node host works. The steps below use
[Koyeb](https://www.koyeb.com) (free, deploys from GitHub). Render works too —
see the note at the end.

1. Push this folder to a GitHub repo.
2. In Koyeb: **Create Web Service → GitHub**, pick the repo. It auto-detects
   Node and uses `npm install` (build) + `npm start` (run).
3. Set environment variables:
   - `MOD_CODE` — the code you give your mods.
   - `HOST_SECRET` — a long random string only you (the streamer) know.
   - `PORT` — leave unset; the host provides it and the server reads it.
4. Deploy. You get a URL like `https://your-app-org.koyeb.app` — that single URL
   is the whole app (host + viewer). Every push to the repo auto-redeploys.

> **Render instead?** Identical flow: New → **Web Service** (not Static Site),
> connect the repo, same env vars. The included `render.yaml` pre-fills the
> build/start commands.

### Run locally (for development)

```bash
npm install
cp config.example.json config.json   # then edit MOD_CODE / HOST_SECRET
npm start                             # http://localhost:3000
```

`config.json` is git-ignored. Environment variables override it.

---

## Streamer's first run

1. Open your app URL on the **streaming PC** (in Chrome/Edge).
2. The tab detects host mode and asks for your **`HOST_SECRET`** once
   (saved in this browser only). Tip: open
   `https://your-app.onrender.com/?key=YOUR_HOST_SECRET` to skip the prompt.
3. **Approve the YouTube Music authorization popup** that appears in the
   YTMDesktop app (one time — the token is saved afterward).
4. **Leave the tab open** for the whole stream. That's it.

> **Start the queue with "Force."** When songs are accepted they line up under
> *Up next*. Hit **Force** on the first one to start playback; after that each
> song **auto-advances** to the next when it finishes.

## Mods

Open the same app URL, enter the **mod code**, and you'll see the live queue:

- **Accept** — approve a request; it moves to *Up next*.
- **Force** — play it immediately.
- **Decline** — remove it.

If you see **"Host offline — playback paused,"** the streamer's queue tab isn't
open; actions won't play until it is.

---

## Streamer.bot

No new Streamer.bot action is needed. Your existing reward whose **title contains
"song request"** already emits `Twitch.RewardRedemption`, and the host tab listens
to it directly (same as the multichat widget). Requirement: Streamer.bot's
**WebSocket server must be enabled on `127.0.0.1:8080`** (it already is for the
widget). The viewer's typed text (`user_input`) is the song query.

---

## Resolving a YouTube Music videoId

`ytmd://play/<videoId>` needs a YouTube **videoId**, which the metadata search
doesn't provide. [`ResolveYouTubeVideoId`](public/app.js) handles it, isolated so
you can swap the strategy:

- **Default (zero-config):** scrape the first result's videoId from a normal
  YouTube search page, fetched through the same public CORS proxy the metadata
  search already uses. No API key.
- **Optional (more robust):** YouTube Data API v3. Provide a key via
  `?ytKey=YOUR_KEY` once (saved locally) or set `localStorage['srq_yt_api_key']`.
  Restrict the key to your app domain in Google Cloud. When present it's
  preferred over the scrape.

If no videoId can be found, the song is **still queued** but flagged
*not playable* so mods see why.

---

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Thin Render sync server (Express + SSE, in-memory). Stays dumb. |
| `public/index.html` | The single page (host + viewer modes). |
| `public/app.js` | All client logic: mode detection, host engine, viewer UI, song search. |
| `public/style.css` | Minimal styling (a custom design comes later). |
| `render.yaml` | Render blueprint. |
| `config.example.json` | Copy to `config.json` for local dev. |
