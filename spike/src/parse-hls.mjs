// HLS playlist parsing: master (video variants + audio renditions) and media (init map +
// segments). Handles BOTH byte-range playlists (one file indexed by EXT-X-BYTERANGE, the
// Apple test stream) and discrete-segment playlists (separate .m4s files, the Twitter case).
// One code path covers both so the spike result transfers directly to Twitter/X.

/** Parse an HLS attribute list, honoring quoted values that may contain commas
 *  (e.g. CODECS="avc1.640020,mp4a.40.2"). */
export function parseAttrs(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let v = m[2];
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

/** "length@offset" -> { length, offset? } (offset is optional per the HLS spec). */
function parseByteRange(str) {
  if (!str) return undefined;
  const [len, off] = str.split('@');
  return { length: Number(len), offset: off !== undefined ? Number(off) : undefined };
}

const resolve = (uri, base) => new URL(uri, base).href;

/**
 * Parse a master playlist into video variants + audio rendition groups.
 * @returns {{ videoVariants: Array<Object>, audioGroups: Record<string, Array<Object>> }}
 */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const videoVariants = [];
  const audioGroups = {};
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO' && a.URI) {
        const gid = a['GROUP-ID'];
        (audioGroups[gid] ||= []).push({
          groupId: gid,
          name: a.NAME,
          channels: a.CHANNELS ? Number(a.CHANNELS) : undefined,
          def: a.DEFAULT === 'YES',
          language: a.LANGUAGE,
          uri: resolve(a.URI, baseUrl),
        });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
      const res = a.RESOLUTION;
      pending = {
        bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : undefined,
        avgBandwidth: a['AVERAGE-BANDWIDTH'] ? Number(a['AVERAGE-BANDWIDTH']) : undefined,
        resolution: res,
        width: res ? Number(res.split('x')[0]) : undefined,
        height: res ? Number(res.split('x')[1]) : undefined,
        codecs: a.CODECS,
        frameRate: a['FRAME-RATE'] ? Number(a['FRAME-RATE']) : undefined,
        audioGroup: a.AUDIO,
      };
    } else if (line && !line.startsWith('#') && pending) {
      pending.uri = resolve(line, baseUrl);
      videoVariants.push(pending);
      pending = null;
    }
  }
  return { videoVariants, audioGroups };
}

/**
 * Parse a media (variant or audio) playlist.
 * @returns {{ map, segments, targetDuration, totalDuration, hasByteRanges }}
 */
export function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let map = null;
  const segments = [];
  let targetDuration = 0;
  let pendingDuration = 0;
  let pendingRange;
  const lastEnd = {}; // running offset per-resource for implicit BYTERANGE offsets
  let anyRange = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      map = { uri: resolve(a.URI, baseUrl), byterange: parseByteRange(a.BYTERANGE) };
      if (map.byterange) anyRange = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]);
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      anyRange = true;
    } else if (line && !line.startsWith('#')) {
      const uri = resolve(line, baseUrl);
      let byterange = pendingRange;
      if (byterange && byterange.offset === undefined) {
        byterange = { length: byterange.length, offset: lastEnd[uri] ?? 0 };
      }
      if (byterange) lastEnd[uri] = byterange.offset + byterange.length;
      segments.push({ uri, duration: pendingDuration, byterange });
      pendingDuration = 0;
      pendingRange = undefined;
    }
  }
  const totalDuration = segments.reduce((s, x) => s + (x.duration || 0), 0);
  return { map, segments, targetDuration, totalDuration, hasByteRanges: anyRange };
}

/** Keep only the leading segments up to maxSeconds (spike convenience — lets a short slice of a
 *  long VOD fit under a cap and download fast, while exercising the exact same pipeline). */
export function trimMedia(media, maxSeconds) {
  if (!maxSeconds || maxSeconds <= 0) return media;
  const segments = [];
  let acc = 0;
  for (const s of media.segments) {
    if (acc >= maxSeconds) break;
    segments.push(s);
    acc += s.duration || 0;
  }
  const kept = segments.length ? segments : media.segments.slice(0, 1);
  const totalDuration = kept.reduce((a, x) => a + (x.duration || 0), 0);
  return { ...media, segments: kept, totalDuration };
}
