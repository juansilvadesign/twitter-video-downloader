// Fetch a rendition's init + segments and concatenate into one contiguous fMP4 byte stream.
// Browser version (runs in the offscreen document): returns a Uint8Array. fetch() here has the
// extension's host_permissions for *.twimg.com, so cross-origin segment reads are not CORS-blocked.
// Retry-with-timeout was added after a real Twitter segment fetch timed out during the spike.

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
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${uri} (${lastErr?.message || lastErr})`);
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Returns a single Uint8Array: [init] ++ [seg0] ++ [seg1] ++ ... in playlist order. */
export async function fetchRendition(media, { concurrency = 6, onProgress = () => {} } = {}) {
  const parts = [];
  if (media.map?.uri) parts.push({ uri: media.map.uri, byterange: media.map.byterange });
  for (const s of media.segments) parts.push({ uri: s.uri, byterange: s.byterange });

  const chunks = new Array(parts.length);
  let done = 0;
  for (let i = 0; i < parts.length; i += concurrency) {
    const batch = parts.slice(i, i + concurrency);
    await Promise.all(batch.map(async (p, j) => {
      chunks[i + j] = await fetchPart(p);
      onProgress(++done, parts.length);
    }));
  }
  return concatChunks(chunks);
}
