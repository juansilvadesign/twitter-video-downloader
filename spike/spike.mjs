#!/usr/bin/env node
// No-UI spike for the Twitter Video Downloader idea.
//
// Pipeline: fetch master m3u8 -> parse -> size-capped variant pick -> fetch the SEPARATE
// audio + video fMP4 renditions -> remux into one playable MP4 -> verify (ffprobe + full decode).
//
// URL-agnostic. Defaults to Apple's "advanced fMP4" example, which has the SAME structure as
// Twitter/X (separate EXT-X-MEDIA audio group + H.264 video variants, CMAF fMP4). Point it at a
// real Twitter master playlist with no code change:
//
//   node spike.mjs                              # Apple test stream, 10 MB cap, first 30 s
//   node spike.mjs --cap=8 --seconds=20
//   node spike.mjs "https://video.twimg.com/.../<master>.m3u8" --cap=10
//
// Two muxer backends run and are compared:
//   ffmpeg-copy : ground truth that NO transcode is needed (not the browser path)
//   mp4box.js   : the browser-viable JS stack we actually need to validate

import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMaster, parseMedia, trimMedia } from './src/parse-hls.mjs';
import { renditionSize, selectVariant, MB } from './src/select-variant.mjs';
import { fetchRendition } from './src/fetch-stream.mjs';
import { muxFfmpeg } from './src/mux-ffmpeg.mjs';
import { muxMp4box } from './src/mux-mp4box.mjs';
import { probe, decodeCheck } from './src/probe.mjs';

const APPLE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';
const fmtMB = (b) => (b / MB).toFixed(2) + ' MB';

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

function pickAudioRendition(audioGroups, videoVariants) {
  if (!Object.keys(audioGroups).length) return null;
  // Pair with the audio group that the highest-bitrate AAC (mp4a) video variant references.
  // Correct for both Twitter (-> audio-128000) and Apple (-> AAC "aud1", skipping AC-3/EC-3).
  const aac = videoVariants
    .filter((v) => /mp4a/i.test(v.codecs || ''))
    .sort((a, b) => (b.avgBandwidth || b.bandwidth || 0) - (a.avgBandwidth || a.bandwidth || 0));
  const group = (aac[0]?.audioGroup && audioGroups[aac[0].audioGroup]) ||
    Object.values(audioGroups).find((g) => g.some((r) => r.channels === 2)) ||
    Object.values(audioGroups)[0];
  return group.find((r) => r.def) || group[0];
}

async function main() {
  const args = process.argv.slice(2);
  const masterUrl = args.find((a) => a.startsWith('http')) || APPLE;
  const num = (flag, def) => {
    const a = args.find((x) => x.startsWith(`--${flag}=`));
    return a ? Number(a.split('=')[1]) : def;
  };
  const capMB = num('cap', 10);
  const maxSeconds = num('seconds', 30); // 0 = whole video
  const capBytes = capMB * MB;

  const here = fileURLToPath(new URL('.', import.meta.url));
  const outDir = join(here, 'out');
  await mkdir(outDir, { recursive: true });

  console.log('\n=== Twitter Video Downloader — no-UI spike ===');
  console.log(`master  : ${masterUrl}`);
  console.log(`cap     : ${capMB} MB${maxSeconds ? `   (first ${maxSeconds}s slice)` : ''}\n`);

  // 1. master playlist
  const { videoVariants, audioGroups } = parseMaster(await fetchText(masterUrl), masterUrl);
  console.log(`Parsed master: ${videoVariants.length} video variants; ` +
    `audio groups: ${Object.keys(audioGroups).join(', ') || '(none — muxed)'}`);

  // 2. audio rendition (sized once; shared across video variants)
  const audioRend = pickAudioRendition(audioGroups, videoVariants);
  let audioMedia = null, audioBytes = 0;
  if (audioRend) {
    audioMedia = trimMedia(parseMedia(await fetchText(audioRend.uri), audioRend.uri), maxSeconds);
    ({ bytes: audioBytes } = await renditionSize(audioMedia));
    console.log(`Audio   : group "${audioRend.groupId}" ${audioRend.channels || '?'}ch -> ${fmtMB(audioBytes)}\n`);
  } else {
    console.log('Audio   : none separate (muxed into the video variant)\n');
  }

  // 3. size-capped selection (exact size read BEFORE downloading any media)
  console.log('Measuring variants — highest whose (video + audio) fits the cap:');
  const { chosen } = await selectVariant({
    videoVariants, audioBytes, capBytes, maxSeconds,
    log: (r) => console.log(
      `  ${(r.resolution || '?').padEnd(11)} ` +
      `vid ${fmtMB(r.videoBytes).padStart(9)}  total ${fmtMB(r.total).padStart(9)} ` +
      `[${r.method}]  est ${r.estimate ? fmtMB(r.estimate).padStart(9) : '     n/a'}  ${r.fits ? 'FITS' : 'over'}`),
  });

  if (!chosen) {
    console.log(`\nNo variant fits under ${capMB} MB (even the lowest exceeds the cap).`);
    console.log('Per the spec, a cap below the lowest variant is the later "transcode" version (out of v1 scope).');
    process.exit(2);
  }
  console.log(`\nChosen  : ${chosen.resolution} @ ${(chosen.avgBandwidth / 1e6).toFixed(2)} Mbps ` +
    `-> ${fmtMB(chosen.total)} total (<= ${capMB} MB)\n`);

  // 4. download the chosen renditions
  const prog = (label) => (d, t) => process.stdout.write(`\r${label} ${d}/${t}`);
  process.stdout.write('Fetching video segments...');
  const videoBuf = await fetchRendition(chosen.media, { onProgress: prog('Fetching video segments...') });
  console.log(` -> ${fmtMB(videoBuf.length)}`);
  let audioBuf = null;
  if (audioMedia) {
    process.stdout.write('Fetching audio segments...');
    audioBuf = await fetchRendition(audioMedia, { onProgress: prog('Fetching audio segments...') });
    console.log(` -> ${fmtMB(audioBuf.length)}`);
  }

  // 5. remux with both backends, then verify each output
  const results = [];
  for (const [name, fn] of [['ffmpeg-copy', muxFfmpeg], ['mp4box.js', muxMp4box]]) {
    const out = join(outDir, `out.${name.replace(/[^a-z0-9]/gi, '_')}.mp4`);
    process.stdout.write(`\nRemux [${name}] ... `);
    try {
      await fn(videoBuf, audioBuf, out);
      const info = await probe(out);
      const dec = await decodeCheck(out);
      const v = info.streams.find((s) => s.type === 'video');
      const a = info.streams.find((s) => s.type === 'audio');
      const tracksOk = !!v && (!audioMedia || !!a);
      const sz = (await stat(out)).size;
      console.log('written');
      console.log(`   size   : ${fmtMB(sz)}   duration ${info.durationSec?.toFixed(1)}s`);
      console.log(`   video  : ${v ? `${v.codec} ${v.width}x${v.height}` : 'MISSING'}`);
      console.log(`   audio  : ${a ? `${a.codec} ${a.channels}ch` : (audioMedia ? 'MISSING' : 'n/a')}`);
      const decNote = dec.ok
        ? (dec.warnings
          ? `decodable (${dec.warnings} benign non-monotonic-DTS warning(s) — Twitter B-frames, same as yt-dlp)`
          : 'clean (fully decodable)')
        : 'FATAL -> ' + dec.fatal.split('\n')[0];
      console.log(`   decode : ${decNote}`);
      results.push({ name, ok: tracksOk && dec.ok, tracksOk, decodeOk: dec.ok, out });
    } catch (e) {
      console.log(`FAILED: ${e.message || e}`);
      if (process.env.SPIKE_DEBUG) console.log(e.stack || '');
      results.push({ name, ok: false, error: e.message || String(e) });
    }
  }

  // 6. verdict
  console.log('\n=== Verdict ===');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}` +
      (r.error ? `  (${r.error})` : r.ok ? '' : `  (tracks:${r.tracksOk ? 'ok' : 'no'} decode:${r.decodeOk ? 'ok' : 'no'})`));
  }
  const ref = results.find((r) => r.name === 'ffmpeg-copy');
  const js = results.find((r) => r.name === 'mp4box.js');
  console.log(`\nPipeline (parse -> cap-pick -> fetch separate A/V -> remux): ${ref?.ok || js?.ok ? 'PROVEN' : 'FAILED'}`);
  console.log(`No-transcode container copy is sufficient: ${ref?.ok ? 'YES (ffmpeg -c copy, verified by full decode)' : 'unconfirmed'}`);
  console.log(`Browser-viable JS remux (mp4box.js) interleaves separate A/V: ${js?.ok ? 'YES' : 'NO — see above'}`);
  console.log('');
}

main().catch((e) => { console.error('\nSPIKE ERROR:', e); process.exit(1); });
