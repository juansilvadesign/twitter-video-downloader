# Twitter Video Downloader — MV3 extension

Manifest V3 browser extension. Adds a download button to each video tweet's action bar and a
paste-link popup, and downloads the highest resolution that fits a chosen size cap (default 10 MB
for Discord). Pure client-side — no server, no native host, no ffmpeg.wasm.

> **Status: working — verified in Chrome (2026-06-24).** End-to-end download confirmed on a live
> tweet: action-bar button → size-capped pick (1080×1440 under a 10 MB cap) → mp4box remux → MP4 in
> Downloads (7.59 MB, byte-identical to the spike's validated output). The full runtime wiring
> (button injection, offscreen lifecycle, mp4box in the offscreen doc, blob→`chrome.downloads`) is
> proven. See "Gotchas" for the non-obvious things that had to be right.

## Architecture

```
content.js ─(statusId)─┐
                       ├─► background.js (service worker)
popup.js ─(url/cap)────┘        │  ensures offscreen, routes job, saves via chrome.downloads
                                ▼
                        offscreen.html/js  ◄── the workhorse (full DOM: window, URL, fetch)
                                │
              lib/tweet.js → resolveTweetVideo(statusId)         (syndication → master m3u8)
              lib/parse-hls.js → parse master + media playlists
              lib/select-variant.js → exact size (HEAD/byte-range) → highest under cap
              lib/fetch-stream.js → fetch separate A/V .m4s → concat fMP4   (retries)
              lib/mux-mp4box.js → mp4box remux video⊕audio → one MP4 (Uint8Array)
                                │
                          Blob → URL.createObjectURL → back to SW → chrome.downloads.download
```

**Why an offscreen document?** mp4box.js is a CommonJS/classic library that touches `window`, and
it needs `URL.createObjectURL` to produce a downloadable file — neither exists in an MV3 service
worker. An offscreen document is a real (hidden) page with a full DOM, and its `fetch` carries the
extension's `host_permissions` for `*.twimg.com`, so cross-origin segment reads are not CORS-blocked.
The service worker stays a thin router and owns only `chrome.downloads`.

The `lib/` modules are the spike's `src/` code, adapted only where Node ↔ browser differ
(`Buffer`→`Uint8Array`, `writeFile`→return bytes, `require('mp4box')`→global `MP4Box`).

## Load it (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Open a tweet with a video on `x.com` → a download arrow appears in the action bar (right of
   Share). Or click the toolbar icon and paste a tweet / `.m3u8` link. Set the size cap in the popup.

## Verified in Chrome (2026-06-24)

- [x] **Button injection** — appears once per video tweet; survives X's React re-renders (delegation).
- [x] **Offscreen + mp4box** — `vendor/mp4box.all.js` loads and remuxes in the offscreen doc.
- [x] **Blob → download** — `chrome.downloads.download` saved the offscreen-created `blob:` URL directly
      (no `data:` fallback needed).
- [x] **CORS in-context** — offscreen fetch/HEAD against `video.twimg.com` works via `host_permissions`.
- [x] **Syndication resolver** — resolves the master m3u8 under the extension origin too.

Selectors in `content.js` remain heuristic — the most likely thing to need updating when X changes
its markup.

## Gotchas (non-obvious things this had to get right)

Hard-won during in-Chrome debugging; each caused a silent failure:

1. **Message `...spread` clobbers `type`.** `sendMessage({ type: 'tvd-run', ...job })` where `job`
   carries `type: 'tvd-download'` → the spread overwrites the type, the offscreen ignores it, and the
   job silently never runs (symptom: timeout / "no response"). Forward explicit fields; never spread a
   message object that has its own `type`.
2. **Offscreen-listener readiness race.** `chrome.offscreen.createDocument()` resolves before a
   deferred ES-module offscreen script registers its `onMessage` listener, so the first job is dropped.
   Fix: a `tvd-ping` handshake — wait for the offscreen to answer before sending the job.
3. **mp4box's globals differ by build.** As a classic browser script, mp4box puts only `createFile` on
   the `MP4Box` object; `DataStream`, `Log`, `BoxParser` are **separate globals** (`globalThis.DataStream`).
   Only the Node/CommonJS `require('mp4box')` bundles them under one object. Using `MP4Box.DataStream` in
   the browser throws `undefined`.
4. **Event delegation beats per-button listeners on X.** A listener bound to an injected button dies when
   React re-renders the action bar. A single capture-phase `document` click listener survives re-renders
   and fires before X's own handlers.
5. **Robustness add-ons:** results come back via a decoupled `tvd-result` message (the async
   `sendResponse` channel is fragile for long offscreen work), the offscreen relays its log trace to the
   SW console (`tvd-log`), and every fetch has an `AbortSignal.timeout` so a stall self-reports instead of
   hanging.

## Known limitations / next

- Output is a fragmented MP4 (one moof per sample, ≈ +5 % size) — playable everywhere; flatten later
  if desired.
- Carries Twitter's benign non-monotonic-DTS quirk (B-frames) — same as yt-dlp's output; harmless.
- No progress bar yet (button has loading/done/error states; the popup shows a status line).
- `lib/tweet.js` syndication is the one fragile dependency; a page/network `.m3u8` sniff is the
  documented fallback if Twitter changes it.

## Files

```
manifest.json     MV3 manifest
background.js     service worker (router, offscreen mgmt, chrome.downloads)
content.js/.css   action-bar button injection (MutationObserver)
popup.html/.js/.css  paste-link + size-cap setting (chrome.storage.sync)
offscreen.html/.js   download workhorse (loads mp4box, runs the pipeline)
lib/              the validated spike pipeline, browser-adapted
vendor/mp4box.all.js  mp4box.js 0.5.4
icons/            extension icons (16/24/32/48/128) generated from ../assets/logo/logo.png
```
