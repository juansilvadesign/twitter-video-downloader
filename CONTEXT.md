# CONTEXT.md — Twitter Video Downloader

Product and architecture brief. The operating rules are in [`CLAUDE.md`](CLAUDE.md); planned work is
in [`BACKLOG.md`](BACKLOG.md). Origin/spec history: `knowledge/ideas/twitter-video-downloader.md`.

## What it is and why

A personal MV3 extension to download Twitter/X videos **without the ssstwitter.com round-trip**, and
specifically to get a file that **fits a size cap** (Discord rejects video over 10 MB). The headline
feature is: set a max size, and the extension downloads the highest-resolution variant that stays
under it — killing the "download → too big → redo smaller" loop.

It is deliberately **not** an extension of the sibling `one-click-video-downloader`: that tool's
value is one-click auto-detect, which grabs the wrong video on Twitter pages where several videos
play at once. Here selection is always explicit (which tweet's button, or which pasted link).

## How Twitter serves video (the constraints that shaped everything)

- **HLS, not progressive MP4.** A master `.m3u8` → per-resolution media playlists → fragmented-MP4
  segments (`#EXT-X-MAP` init `.mp4` + `.m4s` segments). On the `amplify_video` shard segments are
  separate `.m4s` files; the player's `<video>.src` is a `blob:` MSE URL (not downloadable directly).
- **Video and audio are separate renditions** (`#EXT-X-MEDIA TYPE=AUDIO`, AAC at 32k/64k/128k). A
  video variant carries no audio — you must fetch a matching audio rendition and **mux** them.
- **Discrete bitrate ladder** (e.g. 2160×2880 → 320×426), so size-capped selection has real choices.
- **Size is knowable before downloading any media byte:** exact via summed `HEAD` `Content-Length`
  (validated cross-origin), or estimate via `AVERAGE-BANDWIDTH × duration` (CORS-independent fallback).
- **Remux needs no transcode.** Segments are clean H.264 + AAC fMP4; concatenating each track and
  re-containerizing into one MP4 is enough — **mp4box.js (~1 MB), not ffmpeg.wasm (~25 MB)**.
- **Benign quirk:** Twitter's B-frames make ffmpeg emit a non-monotonic-DTS warning on `-c copy`;
  it's intrinsic (PTS stays monotonic), harmless, and present in yt-dlp's output too.

These were validated empirically — in the browser (CORS/DOM probes) and in Node against a live
tweet (`spike/`). See `spike/README.md` and the Findings in the idea capture.

## Architecture

```
content.js ──(statusId)──┐
                         ├─► background.js (service worker: ensure offscreen, ping, route, downloads)
popup.js ──(url/cap)─────┘                     │
                                               ▼  decoupled tvd-result + tvd-log relay
                          offscreen.html/js  (full DOM + host-permission fetch)
                                               │
   lib/tweet.js          resolveTweetVideo(statusId)   syndication tweet-result → master m3u8 (no auth)
   lib/parse-hls.js      master + media playlists (byte-range AND discrete .m4s)
   lib/select-variant.js exact size (HEAD / byte-range) → highest variant under the cap
   lib/fetch-stream.js   fetch init + segments (retries, timeouts) → one fMP4 Uint8Array
   lib/mux-mp4box.js     mp4box remux video⊕audio, interleave by DTS → one MP4 Uint8Array
                                               │
                          Blob → URL.createObjectURL → SW → chrome.downloads.download
```

**Why the offscreen document:** mp4box touches `window` and needs `URL.createObjectURL`, neither of
which exists in an MV3 service worker; an offscreen document is a real hidden page that has them, and
its `fetch` carries the extension's `host_permissions` for `*.twimg.com` (no CORS block). The SW
stays a thin router owning only `chrome.downloads`.

### The two halves

- **`extension/`** — the shipped product (see `extension/README.md`, incl. the Gotchas section).
- **`spike/`** — the no-UI Node validator that de-risked the whole pipeline before any UI existed.
  It runs the identical chain and is the regression check that doesn't need a browser. The Apple
  "advanced fMP4" HLS example is its structural stand-in for Twitter (separate AAC audio group +
  H.264 variants); point it at a real Twitter master to test the live target.

### Supporting

- `assets/logo/` — brand logo (`logo.png` black rounded-square app icon; `-nobg` and `.svg` variants).
  Extension `icons/` are downscaled from `logo.png`.
- `assets/icons/download.svg` — the action-bar download glyph (used in `content.js`, recolored to
  `currentColor` so the CSS hover applies).
- `webfont-converter`, `one-click-video-downloader` — sibling personal projects, unrelated runtime.

## Current state

**Working — verified in Chrome (2026-06-24).** End-to-end download confirmed on a live tweet
(1080×1440, 7.59 MB, byte-identical to the spike's validated output). The syndication resolver,
size-cap selection, separate-A/V fetch, mp4box remux, and the offscreen→SW blob→`chrome.downloads`
hand-off all work. Remaining items are polish — see `BACKLOG.md`.

## Key decisions (history)

- Standalone, not an extension of one-click (multi-video pages break auto-detect).
- HLS + mp4box remux over progressive MP4 — the HLS ladder gives finer size control, and the
  syndication API's progressive MP4 variants are a limited fallback only.
- Offscreen document for the DOM/blob/fetch context; SW for routing + downloads.
- Syndication `tweet-result` (react-tweet token) as the no-auth m3u8 resolver — the one fragile
  external dependency; a page/network `.m3u8` sniff is the documented fallback.
