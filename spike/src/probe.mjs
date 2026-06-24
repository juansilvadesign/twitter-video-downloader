// ffprobe wrapper — used only to VERIFY the muxer output (track count, codecs, duration).
// Not part of the shipped extension; the browser build would trust the remuxer + a playback check.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);

/** ffprobe a file -> { streams:[{type,codec,width,height,channels,duration}], durationSec, sizeBytes }. */
export async function probe(path) {
  const { stdout } = await pexec('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path,
  ]);
  const j = JSON.parse(stdout);
  const streams = (j.streams || []).map((s) => ({
    type: s.codec_type,
    codec: s.codec_name,
    width: s.width,
    height: s.height,
    channels: s.channels,
    duration: s.duration ? Number(s.duration) : undefined,
  }));
  return {
    streams,
    durationSec: j.format?.duration ? Number(j.format.duration) : undefined,
    sizeBytes: j.format?.size ? Number(j.format.size) : undefined,
  };
}

// The "non monotonically increasing dts to muxer" line is intrinsic to Twitter's B-frame fMP4
// (PTS stays monotonic, so playback is correct) and is emitted even by yt-dlp's own output —
// ffmpeg still decodes every frame and exits 0. Treat it as a benign warning, not a failure.
const isBenign = (line) => /non monotonically increasing dts/i.test(line);

/** Full decode pass (`-f null`) — actually decodes every audio+video frame. Catches a missing or
 *  broken decoder config (e.g. an empty esds) that a metadata-only ffprobe would not. Judges by
 *  decode completion (exit 0) + absence of NON-benign errors. */
export async function decodeCheck(path) {
  try {
    const { stderr } = await pexec('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-']);
    const lines = (stderr || '').trim().split('\n').filter(Boolean);
    const fatal = lines.filter((l) => !isBenign(l));
    const warnings = lines.filter(isBenign);
    return { ok: fatal.length === 0, fatal: fatal.join('; '), warnings: warnings.length };
  } catch (e) {
    // Non-zero exit = decode did not complete = genuinely broken.
    return { ok: false, fatal: (e.stderr || e.message || '').trim(), warnings: 0 };
  }
}
