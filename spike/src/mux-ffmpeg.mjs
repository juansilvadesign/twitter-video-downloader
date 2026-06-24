// Reference muxer — GROUND TRUTH for "no transcode needed".
// Container-only copy (`-c copy`) of the separate fMP4 video + audio renditions into one MP4.
// This is NOT the browser path (ffmpeg CLI); it exists to prove the elementary streams are
// clean enough that re-containerization alone yields a playable file, and to give a correct
// reference output to compare the pure-JS mp4box.js result against.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
const pexec = promisify(execFile);

export async function muxFfmpeg(videoBuf, audioBuf, outPath) {
  const dir = dirname(outPath);
  const vTmp = join(dir, '.tmp-video.mp4');
  const aTmp = audioBuf ? join(dir, '.tmp-audio.mp4') : null;
  await writeFile(vTmp, videoBuf);
  if (aTmp) await writeFile(aTmp, audioBuf);
  try {
    const args = ['-y', '-i', vTmp];
    if (aTmp) args.push('-i', aTmp);
    args.push('-map', '0:v:0');
    if (aTmp) args.push('-map', '1:a:0');
    args.push('-c', 'copy', '-movflags', '+faststart', outPath);
    await pexec('ffmpeg', args);
  } finally {
    await unlink(vTmp).catch(() => {});
    if (aTmp) await unlink(aTmp).catch(() => {});
  }
  return outPath;
}
