# BACKLOG.md — Twitter Video Downloader

Planned/optional work. Operating rules: [`CLAUDE.md`](CLAUDE.md). Architecture: [`CONTEXT.md`](CONTEXT.md).
Mark an item done only when its acceptance is actually satisfied (runtime items need in-Chrome proof).

## Done

- **Pipeline spike** — parse → size-cap pick → fetch separate A/V → mp4box remux → verify, validated
  in Node on the Apple fMP4 test stream and on a live Twitter master. (`spike/`)
- **MV3 extension, end-to-end** — action-bar button + popup + SW + offscreen, verified in Chrome on a
  live tweet (1080×1440, 7.59 MB). (`extension/`)
- **Branded icons** — generated at 16/24/32/48/128 from `assets/logo/logo.png`.
- **Action-bar download glyph** — swapped to `assets/icons/download.svg` (recolored to `currentColor`).

## Next — verification (cheap, in-Chrome)

- [ ] **`ext_tw_video` shard** — confirm a download on the 2nd/3rd video of a multi-video page (path
      `…/ext_tw_video/…/pu/…`, a different shard than `amplify_video`). Code is URL-agnostic; just confirm.
- [ ] **Popup paste-link path** — tweet URL and a raw `.m3u8` link, plus a couple of different size caps.
- [ ] **Playback** — confirm a downloaded file plays and uploads to Discord (carries the benign
      B-frame DTS quirk; the spike's full-decode check passed on these exact bytes).

## Next — polish

- [ ] **Progress indicator** — the button has loading/done/error states and the popup a status line,
      but no real progress. Relay `tvd-log` step/percent to the button/popup (segment N/total, remuxing).
- [ ] **Syndication fallback** — `lib/tweet.js` is the one fragile external dependency. Add a
      page/network `.m3u8` sniff (read the master from the player/network) for when syndication changes
      or a tweet is gated. Keep it user-initiated.
- [ ] **Flatten the output MP4** — mp4box.js writes one moof per sample (fragmented, ≈ +5 % size).
      Playable everywhere as-is; flatten/batch fragments if a stricter player ever complains.

## Deferred (out of v1 scope — see CLAUDE.md constraints)

- **Transcode to hit a cap below the lowest variant.** The only case that would pull in ffmpeg.wasm.
  Keep v1 to variant-select + remux.
- **Firefox** — manifest targets MV3 (Chrome/Edge). Firefox MV3 differences untested.
- Anything resembling bulk/automated/timeline harvesting — explicitly out of scope (ethics + ToS).
