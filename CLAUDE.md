# CLAUDE.md — Twitter Video Downloader

Operating contract for Claude Code sessions in this project. Read [`CONTEXT.md`](CONTEXT.md) for the
product + architecture brief and [`BACKLOG.md`](BACKLOG.md) for planned work. The per-folder
`extension/README.md` and `spike/README.md` are the detailed source of truth for each half.

## Session start

Read in this order:

1. `CLAUDE.md` (this file) — the operating contract.
2. `CONTEXT.md` — product, architecture, and the key technical findings.
3. `extension/README.md` — the shipped extension's architecture + the **Gotchas** section.
4. Only the implementation relevant to the request.

The captured idea/spec history lives at `knowledge/ideas/twitter-video-downloader.md`. The
**working extension** and the **validated spike** are the source of truth — do not restart pipeline
discovery; it is already proven end-to-end on real Twitter (Node) and in Chrome.

## Product in one paragraph

A personal Manifest V3 Chrome/Edge extension that downloads a Twitter/X video at the **best
resolution that fits a chosen size cap** (default 10 MB, for Discord). It injects a download button
into each video tweet's action bar and offers a paste-link popup. Twitter serves video as **HLS**
(separate H.264 video + AAC audio fMP4 renditions); the extension resolves the master playlist,
reads each variant's exact size **before** downloading (HEAD `Content-Length`), picks the highest
under the cap, fetches the chosen video + audio segments, and **remuxes them into one MP4 with
mp4box.js** (no transcode, no ffmpeg.wasm). Pure client-side — no server, no native host.

## Hard constraints (never violate)

- **Authorized, user-initiated, single-video only.** The save is gated behind an explicit per-tweet
  click. No bulk/timeline/automated harvesting, no DRM/paywall/login bypass. This is both an ethics
  line and what keeps it within platform terms + the video owner's rights.
- **Client-side only.** No server, no native messaging host, no analytics, no remote processing.
- **No transcode in v1.** Select from the existing HLS variant ladder and **remux** (container only).
  Re-encoding to hit a cap below the lowest variant is a deferred v2 and the only thing that would
  pull in ffmpeg.wasm.
- **Keep the pipeline URL-agnostic.** Parse via relative URL resolution; never hard-code the
  `amplify_video` path shape (videos also come from the `ext_tw_video` shard).
- **Reuse the validated pipeline.** `extension/lib/` is the spike's proven code, browser-adapted.
  Don't fork its logic; fix it in one place.

## Architecture boundaries

Two halves under this folder. See `CONTEXT.md` for the full map.

### `extension/` — the MV3 product (working)

- `content.js` — injects the action-bar button via a **capture-phase delegated** `document` click
  listener (survives X's React re-renders); resolves the tweet's status ID from the `article`
  permalink; sends the job to the background. DOM selectors here are heuristic and the most likely
  thing to need updating when X changes its markup.
- `background.js` — thin service-worker router: ensures the offscreen document, **ping handshake**,
  forwards the job, awaits a **decoupled `tvd-result`** message, saves via `chrome.downloads`.
- `offscreen.html` / `offscreen.js` — the workhorse (full DOM: `window`, `URL.createObjectURL`,
  host-permission fetch). Loads mp4box (classic script) then runs the `lib/` pipeline.
- `lib/` — `parse-hls`, `select-variant`, `fetch-stream`, `mux-mp4box`, `tweet` (syndication
  resolver). Browser-adapted copies of `spike/src/`.
- `popup.*` — paste-link + size-cap setting (`chrome.storage.sync`).
- `vendor/mp4box.all.js` — mp4box.js 0.5.4. `icons/` — generated from `assets/logo/logo.png`.

### `spike/` — the no-UI pipeline validator (Node)

Standalone script proving parse → size-cap pick → fetch separate A/V → remux → verify. URL-agnostic;
run against the Apple fMP4 test stream or a real Twitter master. Keep it working — it's how the
pipeline is regression-checked without a browser.

## Gotchas (already learned — do not relearn)

1. **Never spread a message that carries `type`.** `sendMessage({ type: 'tvd-run', ...job })` where
   `job.type === 'tvd-download'` silently clobbers the type and the offscreen ignores the job.
2. **Offscreen listener readiness race.** `createDocument()` resolves before the deferred ES-module
   offscreen script registers `onMessage`. Use the `tvd-ping` handshake before sending a job.
3. **mp4box globals differ by build.** As a classic browser script, only `createFile` is on the
   `MP4Box` object; `DataStream`, `Log`, `BoxParser` are **separate globals** (`globalThis.DataStream`).
   Only the Node `require('mp4box')` build bundles them under one object.
4. **Event delegation on X**, not per-button listeners (React re-renders orphan them).
5. **Twitter's benign non-monotonic-DTS warning** (B-frames) is intrinsic and harmless — yt-dlp's
   output has it too. Do not "fix" it with a transcode.
6. **`$json`/Node↔browser**: `Buffer`→`Uint8Array`, `writeFile`→return bytes. Per-fetch
   `AbortSignal.timeout` so a stall self-reports instead of hanging.

## Validate / test

```bash
# Pipeline regression (Node) — Apple test stream or a real Twitter master:
cd spike && npm install && node spike.mjs --seconds=20
node spike.mjs "https://video.twimg.com/.../<master>.m3u8" --cap=10 --seconds=0

# Get a master URL from a tweet (testing only; the extension reads it from the page):
.venv/bin/yt-dlp -J --no-warnings "<tweet-url>" | .venv/bin/python -c "import sys,json;d=json.load(sys.stdin);print(sorted({f['manifest_url'] for f in d['formats'] if f.get('manifest_url')})[0])"

# Syntax check any changed JS (ESM files: copy to .mjs first):
node --check background.js content.js popup.js
```

Browser-facing changes also require a manual unpacked-extension check (`chrome://extensions` →
reload → reload the x.com tab → click a button → watch the service-worker console for the
`[TVD][offscreen]` trace). This WSL environment may have no GUI Chrome — separate automated
evidence from pending in-Chrome verification.

## Definition of done

- The relevant half still works: `spike` pipeline passes, or the extension downloads end-to-end in
  Chrome (button → size-cap pick → remux → file in Downloads).
- No transcode added; pipeline stays URL-agnostic; client-side only; single-video user-initiated.
- `extension/README.md` Gotchas + this file updated if a new non-obvious failure mode is found.
- `BACKLOG.md` status changed only when actually satisfied (in-Chrome verification for runtime items).

For diagnosis-only requests, explain the cause; do not implement unless asked.

## Common mistakes

- Spreading a `type`-bearing object into a `sendMessage` (clobbers the type — gotcha #1).
- Using `MP4Box.DataStream` in the browser (it's `globalThis.DataStream` — gotcha #3).
- Binding click listeners per injected button instead of delegating (gotcha #4).
- Hard-coding the `amplify_video` URL shape; assuming a single muxed track (audio is separate).
- Forking `lib/` logic instead of fixing the one shared copy.
- Trying to download Twitter's `<video>` `blob:` URL directly (it's MSE — resolve the m3u8 instead).
- "Fixing" the benign DTS warning with a transcode.
