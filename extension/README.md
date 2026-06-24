# Twitter Video Downloader — MV3 extension

Manifest V3 browser extension. Adds a download button to each video tweet's action bar and a
paste-link popup, and downloads the highest resolution that fits a chosen size cap (default 10 MB
for Discord). Pure client-side — no server, no native host, no ffmpeg.wasm.

> **Status: scaffold.** The full download pipeline (resolve → parse → size-cap pick → fetch
> separate A/V → mp4box.js remux) is the code validated end-to-end on real Twitter by `../spike/`,
> and the tweet→m3u8 resolver is verified too. What still needs a real Chrome to confirm is the
> **runtime wiring** (button injection, offscreen lifecycle, mp4box in the offscreen doc, and the
> blob→`chrome.downloads` hand-off). See "Verify in Chrome" below.

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

## Verify in Chrome (the parts Node can't cover)

- [ ] **Button injection** — appears on timeline / detail / quoted-tweet videos; survives scroll
      (virtual-scroll recycling) without duplicates. Selectors in `content.js` are heuristic and are
      the most likely thing to need updating when X changes its markup.
- [ ] **Offscreen + mp4box** — confirm `vendor/mp4box.all.js` loads in the offscreen doc and remuxes
      (it uses `window.URL` internally; the offscreen page has it — the SW would not).
- [ ] **Blob → download** — `chrome.downloads.download` saving an offscreen-created `blob:` URL.
      If it balks, fall back to a `data:` URL or trigger the save from the offscreen doc.
- [ ] **CORS in-context** — segment HEAD/GET from the offscreen doc against `video.twimg.com` and
      non-`amplify_video` shards (`ext_tw_video`). host_permissions should make this a non-issue.
- [ ] **Syndication resolver** — verified in Node today; confirm under the extension origin too.

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
icons/            placeholder icons (replace before any real use)
```
