// Fetch a rendition's init + media segments and concatenate them into one contiguous fMP4
// byte stream. Honors byte-ranges (single-file playlists) and whole-file segments (Twitter
// .m4s). The concatenation of [init] ++ [seg0] ++ [seg1] ++ ... is a valid fMP4 stream.

async function fetchPart({ uri, byterange }, { retries = 3, timeoutMs = 30000 } = {}) {
  const headers = {};
  if (byterange) {
    const start = byterange.offset ?? 0;
    headers.Range = `bytes=${start}-${start + byterange.length - 1}`;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(uri, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!(r.status === 200 || r.status === 206)) throw new Error(`GET ${uri} -> ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${uri} (${lastErr?.message || lastErr})`);
}

/** Returns a single Buffer: [init] ++ [seg0] ++ [seg1] ++ ... in playlist order. */
export async function fetchRendition(media, { concurrency = 6, onProgress = () => {} } = {}) {
  const parts = [];
  if (media.map?.uri) parts.push({ uri: media.map.uri, byterange: media.map.byterange });
  for (const s of media.segments) parts.push({ uri: s.uri, byterange: s.byterange });

  const buffers = new Array(parts.length);
  let done = 0;
  for (let i = 0; i < parts.length; i += concurrency) {
    const batch = parts.slice(i, i + concurrency);
    await Promise.all(batch.map(async (p, j) => {
      buffers[i + j] = await fetchPart(p);
      onProgress(++done, parts.length);
    }));
  }
  return Buffer.concat(buffers);
}
