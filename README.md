# Twitter Video Downloader

A personal browser extension (Manifest V3) to download Twitter/X videos at the best resolution
that fits a chosen size cap (e.g. ≤ 10 MB for Discord) — without the ssstwitter.com round-trip.

Idea + full spec: [`knowledge/ideas/twitter-video-downloader.md`](../../ideas/twitter-video-downloader.md).

Status: **working — verified in Chrome (2026-06-24).** End-to-end download confirmed on a live tweet.

- [`extension/`](extension/) — the Manifest V3 extension (working). See its README for architecture,
  the verified checklist, and the "Gotchas" learned during in-Chrome debugging.
- [`spike/`](spike/) — the no-UI pipeline spike that de-risked everything below (validated on a live tweet).

**For AI sessions:** [`CLAUDE.md`](CLAUDE.md) (operating contract) · [`CONTEXT.md`](CONTEXT.md)
(architecture + findings) · [`BACKLOG.md`](BACKLOG.md) (planned work).

---

## `spike/` — no-UI pipeline spike (done 2026-06-23)

A standalone Node script that proves the whole download pipeline end-to-end, minus the extension
shell. It was built to de-risk the one unconfirmed step before committing to a UI: **can the
separate audio + video fMP4 renditions be remuxed into one playable MP4 client-side, without the
~25 MB ffmpeg.wasm?**

### What it does

```
fetch master m3u8 → parse (video variants + audio renditions)
  → read each variant's exact size BEFORE downloading (byte-range lengths, or HEAD Content-Length)
  → pick the highest variant whose (video + audio) fits the cap
  → download the chosen video + audio renditions, concatenate each to a contiguous fMP4 stream
  → remux into one MP4 (two backends) → verify with ffprobe + a full decode pass
```

It is **URL-agnostic**. It defaults to Apple's "advanced fMP4" HLS example, which is structurally
identical to Twitter/X (separate `EXT-X-MEDIA` audio group + H.264 video variants in CMAF fMP4),
so the result transfers directly. Point it at a real Twitter master playlist with no code change.

### Run it

```bash
cd spike
npm install
node spike.mjs                          # Apple test stream, 10 MB cap, first 30 s
node spike.mjs --seconds=20 --cap=8
node spike.mjs "https://video.twimg.com/.../<master>.m3u8" --cap=10 --seconds=0
```

`--seconds=N` trims a long VOD to its first N seconds (0 = whole video). The Apple sample is
10 minutes long, so the slice keeps the demo fast while exercising the identical pipeline.

To get a master URL from a tweet (for testing — the extension reads it from the page instead),
a `yt-dlp` venv is bundled:

```bash
cd ..   # project root
python3 -m venv .venv && .venv/bin/pip install yt-dlp     # one-time
.venv/bin/yt-dlp -J --no-warnings "https://x.com/<user>/status/<id>" \
  | .venv/bin/python -c "import sys,json; d=json.load(sys.stdin); \
print(sorted({f['manifest_url'] for f in d['formats'] if f.get('manifest_url')})[0])"
```

### Result (verified)

| Check | Outcome |
|---|---|
| Parse master + media playlists (byte-range **and** discrete-segment) | ✅ |
| Exact size known **before** download (byte-range sum / HEAD `Content-Length`) | ✅ |
| Size-capped pick (highest variant under cap; graceful fail below smallest) | ✅ correct at caps 10 / 4 / 1 MB |
| Fetch separate A/V renditions + concatenate to fMP4 | ✅ |
| Remux **ffmpeg `-c copy`** (ground truth — no transcode) | ✅ fully decodable |
| Remux **mp4box.js** (browser-viable JS, no ffmpeg.wasm) | ✅ fully decodable, h264 + aac |

**Conclusion:** the size-capped, no-transcode, separate-A/V remux is feasible purely client-side
with **mp4box.js** (~1 MB) — ffmpeg.wasm is not needed for the happy path. The size cap can be
honored exactly before fetching a single media byte.

### Validated against real Twitter/X (2026-06-23)

Re-ran against a live tweet's master playlist (`video.twimg.com/amplify_video/.../Z8PWutMcnuTITxJ4.m3u8`).
Everything held on real data, and it surfaced things Apple's byte-range proxy could not:

- The 5-rung Twitter ladder (2160×2880 → 320×426) + `audio-32000/64000/128000` groups parsed correctly.
- **Exact sizing via HEAD `Content-Length`** (the separate-`.m4s` path) confirmed — 6.64 MB measured
  vs 7.00 MB bitrate estimate; the cap correctly chose 1080×1440, skipping the 20 MB 4K.
- Both `ffmpeg -c copy` and **mp4box.js** produced playable h264 + aac MP4s.
- **Benign DTS warning.** Twitter's B-frame fMP4 makes ffmpeg emit `non monotonically increasing dts`
  on `-c copy`. It's intrinsic to the source (PTS stays monotonic → playback is correct), and
  **yt-dlp's own output emits the identical warning and exits 0**. The decode check now classifies it
  as benign. A true fix would need a transcode (out of v1 scope) — yt-dlp doesn't bother either.
- **Pair the right audio.** `EXT-X-MEDIA` carries no `CHANNELS`; pick the audio group the best AAC
  video variant references (→ `audio-128000` stereo), not the first listed (mono 32 k).
- **Retries needed.** A segment fetch timed out once → added retry-with-timeout; the extension's
  service-worker fetch needs the same.

### Honest caveats (still to verify in the real extension build)

- The spike runs in **Node, so CORS does not apply**. The one genuine unknown left is reading segment
  bytes/headers cross-origin from an **MV3 service worker** — earlier browser probes said `video.twimg.com`
  serves permissive CORS, but confirm in the real build (and on non-`amplify_video` shards).
- The mp4box.js output is a **fragmented MP4 with one moof per sample** (≈ +5 % size). Playable and
  decodable as-is; a production build may want to flatten it or batch fragments.

### Files

```
spike/
  spike.mjs              orchestrator / CLI
  src/parse-hls.mjs      master + media playlist parser (byte-range AND discrete segments)
  src/select-variant.mjs exact sizing + "highest variant under cap"
  src/fetch-stream.mjs   fetch init+segments (honors byte-ranges) → one fMP4 buffer
  src/mux-ffmpeg.mjs     reference muxer (ffmpeg -c copy) — ground truth, NOT the browser path
  src/mux-mp4box.mjs     browser-viable JS muxer (mp4box.js) — the validated stack
  src/probe.mjs          ffprobe + full-decode verification
```

Requires Node 18+ (built on 22) and `ffmpeg`/`ffprobe` on PATH (used only for the reference
muxer and verification — the shipped extension would not depend on them).
