// Resolve a tweet's HLS master playlist from a status ID, via Twitter's public syndication
// endpoint (no auth, no login cookies). Token algorithm is the documented react-tweet one.
//
// NOTE: syndication is undocumented and is the most likely piece to need iteration if Twitter
// changes it. Fallback strategy (not yet implemented): a webRequest/page sniff of the .m3u8 the
// player loads. The download pipeline downstream is URL-agnostic, so only this resolver is fragile.

function tweetToken(id) {
  // ((id / 1e15) * PI) in base-36, with zeros and the dot stripped.
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** Accepts a tweet URL or a bare numeric ID; returns the status ID string or null. */
export function extractStatusId(urlOrId) {
  if (!urlOrId) return null;
  if (/^\d+$/.test(urlOrId)) return String(urlOrId);
  const m = String(urlOrId).match(/status(?:es)?\/(\d+)/);
  return m ? m[1] : null;
}

/** -> { masterUrl, title }. Throws a human-readable error if the tweet has no downloadable video. */
export async function resolveTweetVideo(statusId) {
  const token = tweetToken(statusId);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&lang=en&token=${token}`;
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`syndication ${r.status} (tweet may be private, age-gated, or deleted)`);
  const data = await r.json();

  const media = (data.mediaDetails || []).find((m) => m.video_info) ||
    (data.video?.variants ? { video_info: { variants: data.video.variants } } : null);
  if (!media?.video_info) throw new Error('this tweet has no video');

  const variants = media.video_info.variants || [];
  const hls = variants.find((v) => /mpegurl/i.test(v.content_type || '') || /\.m3u8(\?|$)/i.test(v.url || ''));
  if (!hls?.url) throw new Error('tweet video has no HLS (m3u8) variant');

  const title = (data.text || `twitter-${statusId}`)
    .slice(0, 60).replace(/https?:\/\/\S+/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-')
    || `twitter-${statusId}`;
  return { masterUrl: hls.url, title };
}
