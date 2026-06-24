// Offscreen document — the download workhorse. Runs the validated spike pipeline in a context that
// has a full DOM (window, URL.createObjectURL) and host-permission fetch (no CORS). The service
// worker stays thin and just routes jobs here and saves the resulting blob via chrome.downloads.

import { parseMaster, parseMedia } from './lib/parse-hls.js';
import { renditionSize, selectVariant, MB } from './lib/select-variant.js';
import { fetchRendition } from './lib/fetch-stream.js';
import { muxMp4box } from './lib/mux-mp4box.js';
import { resolveTweetVideo, extractStatusId } from './lib/tweet.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'tvd-run') return;
  run(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

const getText = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
  return r.text();
};

/** Pair the audio group that the highest-bitrate AAC video variant references (Twitter -> 128k
 *  stereo; Apple-style -> AAC "aud1", skipping AC-3/EC-3). Matches the spike's validated picker. */
function pickAudio(audioGroups, videoVariants) {
  const groups = Object.values(audioGroups);
  if (!groups.length) return null;
  const aac = videoVariants
    .filter((v) => /mp4a/i.test(v.codecs || ''))
    .sort((a, b) => (b.avgBandwidth || b.bandwidth || 0) - (a.avgBandwidth || a.bandwidth || 0));
  const group = (aac[0]?.audioGroup && audioGroups[aac[0].audioGroup]) ||
    groups.find((g) => g.some((r) => r.channels === 2)) || groups[0];
  return group.find((r) => r.def) || group[0];
}

async function run({ masterUrl, tweetUrl, statusId, capMB }) {
  const capBytes = (capMB || 10) * MB;

  let master = masterUrl;
  let title = 'twitter-video';
  if (!master) {
    const id = statusId || extractStatusId(tweetUrl);
    if (!id) throw new Error('no tweet ID or master URL provided');
    ({ masterUrl: master, title } = await resolveTweetVideo(id));
  }

  const { videoVariants, audioGroups } = parseMaster(await getText(master), master);
  if (!videoVariants.length) throw new Error('no video variants in the master playlist');

  const audioRend = pickAudio(audioGroups, videoVariants);
  let audioMedia = null, audioBytes = 0;
  if (audioRend) {
    audioMedia = parseMedia(await getText(audioRend.uri), audioRend.uri);
    ({ bytes: audioBytes } = await renditionSize(audioMedia));
  }

  const { chosen } = await selectVariant({ videoVariants, audioBytes, capBytes });
  if (!chosen) {
    throw new Error(`No variant fits under ${capMB} MB — even the lowest exceeds the cap (would need transcoding).`);
  }

  const videoBytes = await fetchRendition(chosen.media);
  const audioData = audioMedia ? await fetchRendition(audioMedia) : null;

  const mp4 = await muxMp4box(videoBytes, audioData);
  const blob = new Blob([mp4], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  // The SW kicks off the download synchronously; revoke after it has had time to start.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);

  return {
    ok: true,
    blobUrl,
    filename: `${title}-${chosen.height}p.mp4`,
    resolution: chosen.resolution,
    bytes: blob.size,
  };
}
