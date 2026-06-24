// Size-capped variant selection — the headline feature.
// Exact size is read BEFORE downloading any media: byte-range lengths come straight from
// the playlist (no network), and discrete-segment playlists (Twitter) use HEAD Content-Length.
// A bitrate x duration estimate is computed too as the CORS-independent fallback.

import { parseMedia, trimMedia } from './parse-hls.js';

export const MB = 1024 * 1024;

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

/** Exact byte size of a rendition's init + segments. */
export async function renditionSize(media, { concurrency = 8 } = {}) {
  if (media.hasByteRanges) {
    let total = media.map?.byterange?.length || 0;
    for (const s of media.segments) total += s.byterange?.length || 0;
    return { bytes: total, method: 'byterange' };
  }
  // Discrete files (Twitter): HEAD each unique URL, sum Content-Length.
  const urls = [];
  if (media.map?.uri) urls.push(media.map.uri);
  for (const s of media.segments) urls.push(s.uri);
  const unique = [...new Set(urls)];
  let total = 0;
  let missing = 0;
  for (let i = 0; i < unique.length; i += concurrency) {
    const sizes = await Promise.all(unique.slice(i, i + concurrency).map(async (u) => {
      const r = await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      const len = r.headers.get('content-length');
      return len ? Number(len) : null;
    }));
    for (const sz of sizes) { if (sz == null) missing++; else total += sz; }
  }
  return { bytes: total, method: 'head', missing };
}

/** Estimate from bitrate x duration (the CORS-independent fallback path). */
export function estimateSize(bitsPerSec, durationSec) {
  if (!bitsPerSec || !durationSec) return undefined;
  return Math.round((bitsPerSec / 8) * durationSec);
}

/**
 * Pick the highest-bandwidth video variant whose (video + audio) total fits under capBytes.
 * Measures every variant to print a full report; production can short-circuit at the first fit.
 */
export async function selectVariant({ videoVariants, audioBytes = 0, capBytes, maxSeconds = 0, log = () => {} }) {
  // Dedup by media URI — masters list each video variant once per audio group.
  const byUri = new Map();
  for (const v of videoVariants) if (!byUri.has(v.uri)) byUri.set(v.uri, v);
  const sorted = [...byUri.values()].sort(
    (a, b) => (b.avgBandwidth || b.bandwidth || 0) - (a.avgBandwidth || a.bandwidth || 0),
  );
  const rows = [];
  let chosen = null;
  for (const v of sorted) {
    const media = trimMedia(parseMedia(await fetchText(v.uri), v.uri), maxSeconds);
    const { bytes: videoBytes, method } = await renditionSize(media);
    const total = videoBytes + audioBytes;
    const estimate = estimateSize(v.avgBandwidth || v.bandwidth, media.totalDuration);
    const row = {
      resolution: v.resolution, height: v.height,
      avgBandwidth: v.avgBandwidth || v.bandwidth,
      videoBytes, total, estimate, method, fits: total <= capBytes, media, variant: v,
    };
    rows.push(row);
    log(row);
    if (!chosen && row.fits) chosen = row;
  }
  return { chosen, rows };
}
