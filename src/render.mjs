// One clip in, one shareable .mp4 out.
//
// Slippi's playback Dolphin can dump frames and audio to disk while it plays a
// queue, which is the only way to get a real render of a replay - there is no
// headless renderer. Two things it will not do for us:
//
//  1. Exit. Even with -b the process sits there after the queue drains, so we
//     watch the audio dump instead: it grows at exactly 128000 bytes/second of
//     captured gameplay, so we know precisely when the clip is in the can.
//  2. Produce a usable file. The dump is a raw mpeg4 AVI at the emulator's
//     internal resolution (non-square pixels) plus a separate 32kHz wav, so
//     ffmpeg squares it up to 4:3, encodes h264/aac and muxes.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import * as dolphin from "./dolphin.mjs";

const execFileAsync = promisify(execFile);

const WAV_BYTES_PER_SEC = 32000 * 2 * 2;   // 32kHz, stereo, s16
const POLL_MS = 400;
const STALL_MS = 6000;      // no growth this long after capture started = done
const BOOT_TIMEOUT_MS = 90_000;

// Melee at 60fps is expensive to encode - the stage backgrounds move constantly
// - so these are tuned for a ~10s clip that still fits comfortably in a chat
// message. `good` is the default: 1.5x native resolution, ~10MB for 11 seconds.
/**
 * Is ffmpeg reachable?
 *
 * Every render shells out to it, and without it the failure is a bare ENOENT
 * from deep inside a job - which tells a new user nothing. Checked once at
 * startup so the UI can say what is wrong and how to fix it.
 */
let ffmpegOk = null;
export async function checkFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    ffmpegOk = true;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

export const QUALITY = {
  high: { label: "1080p archive", height: 1080, crf: 20, preset: "medium", internalRes: 3, bitrateKbps: 25000 },
  good: { label: "720p share", height: 720, crf: 21, preset: "medium", internalRes: 2, bitrateKbps: 15000 },
  small: { label: "480p tiny", height: 480, crf: 24, preset: "faster", internalRes: 1, bitrateKbps: 8000 },
  // Deliberately cheap: native internal resolution, small frame, aggressive
  // quantiser. Meant to be watched once in the browser to decide whether the
  // clip is worth a real render, not to be posted anywhere.
  draft: {
    label: "draft preview", height: 360, crf: 30, preset: "veryfast",
    internalRes: 1, bitrateKbps: 4000, audioKbps: 64, draft: true,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };

/** Kill any sandbox Dolphin we left running (a previous render, or a crash). */
export async function killDolphin() {
  try {
    await execFileAsync("taskkill", ["/F", "/IM", dolphin.EXE], { windowsHide: true });
    await sleep(600);   // let Windows release the file handles on the dump
  } catch { /* nothing was running */ }
}

/**
 * Play one clip with dumping on, and wait until the capture is complete.
 * Resolves with the raw dump paths.
 */
async function capture({ replay, startFrame, endFrame, isoPath, quality, onProgress }) {
  const frames = endFrame - startFrame;
  const expectSec = frames / 60;
  const expectBytes = expectSec * WAV_BYTES_PER_SEC;

  dolphin.writeRenderConfigs({
    dump: true,
    internalRes: quality.internalRes,
    bitrateKbps: quality.bitrateKbps,
    // Render silently. Dolphin's audio dump is taken before the volume stage,
    // so muting the speakers leaves the captured wav byte-for-byte identical -
    // verified by md5 against a full-volume capture. The Jukebox has its own
    // output that DSP volume does not reach, and never reaches the dump either,
    // so it gets muted separately and costs nothing.
    volume: 0,
    jukeboxVolume: 0,
    // Uncapped: dumping records every emulated frame however fast they come, so
    // this cuts ~40% off the wall time for a byte-identical capture.
    speed: 0,
  });
  dolphin.clearDump();

  const queueFile = dolphin.writeQueue([{ path: replay, startFrame, endFrame }]);
  const { frames: frameDir, audio: audioDir } = dolphin.dumpPaths();
  const wav = path.join(audioDir, "dspdump.wav");
  const avi = path.join(frameDir, "framedump0.avi");

  const run = dolphin.runQueue(queueFile, { isoPath, hidden: true });
  run.catch(() => { /* we terminate it ourselves; exit status is not the signal */ });

  const began = Date.now();
  let lastSize = -1;
  let lastGrowth = Date.now();
  let capturing = false;

  while (true) {
    await sleep(POLL_MS);
    const size = sizeOf(wav);

    if (size > lastSize) {
      if (!capturing && size > 0) { capturing = true; onProgress?.({ phase: "capturing", pct: 0 }); }
      lastSize = size;
      lastGrowth = Date.now();
    }

    if (capturing) {
      const pct = Math.min(1, size / expectBytes);
      onProgress?.({ phase: "capturing", pct });
      if (size >= expectBytes * 0.995) { await sleep(700); break; }   // let the last frames flush
      if (Date.now() - lastGrowth > STALL_MS) break;                  // finished early / stalled
    } else if (Date.now() - began > BOOT_TIMEOUT_MS) {
      await killDolphin();
      throw new Error("Dolphin never started capturing - is the Melee ISO still where Slippi expects it?");
    }
  }

  await killDolphin();
  if (!fs.existsSync(avi)) throw new Error("Dolphin produced no video dump");
  return { avi, wav, capturedSec: sizeOf(wav) / WAV_BYTES_PER_SEC };
}

/** Square the dump up to 4:3 and encode something you can actually post. */
async function encode({ avi, wav, out, quality, onProgress }) {
  const h = quality.height;
  const w = Math.round((h * 4) / 3 / 2) * 2;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  onProgress?.({ phase: "encoding", pct: 0 });
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", avi,
    "-i", wav,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `scale=${w}:${h}:flags=lanczos,setsar=1`,
    "-c:v", "libx264", "-preset", quality.preset, "-crf", String(quality.crf),
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
    "-c:a", "aac", "-b:a", `${quality.audioKbps ?? 192}k`, "-ar", "48000",
    "-movflags", "+faststart",
    "-shortest",
    out,
  ], { windowsHide: true, maxBuffer: 1 << 24 });
  onProgress?.({ phase: "encoding", pct: 1 });
  return out;
}

/**
 * Render one clip to `out` (.mp4). Returns { file, bytes, durationSec }.
 * Renders are serialised by the caller: only one Dolphin may run at a time.
 */
export async function renderClip({
  replay, startFrame, endFrame, out, quality = "good", onProgress,
}) {
  const q = QUALITY[quality] ?? QUALITY.good;
  const { isoPath } = dolphin.ensureSandbox();
  await killDolphin();

  onProgress?.({ phase: "booting", pct: 0 });
  const { avi, wav, capturedSec } = await capture({
    replay, startFrame, endFrame, isoPath, quality: q, onProgress,
  });
  await encode({ avi, wav, out, quality: q, onProgress });

  return {
    file: out,
    bytes: sizeOf(out),
    durationSec: Math.round(capturedSec * 10) / 10,
  };
}

/**
 * Draft previews: render several clips in ONE Dolphin launch.
 *
 * Booting Melee costs ~9s and playing a clip costs a fraction of that, so
 * previewing five clips one at a time is mostly five boots. Queuing them all
 * gives one continuous dump which we then cut apart - the point of a preview is
 * to decide whether a clip is worth rendering properly, and a boundary that is
 * a couple of frames out does not affect that decision.
 *
 * `clips` are { key, replay, startFrame, endFrame }.
 */
export async function renderDrafts(clips, { outDir, onProgress } = {}) {
  const q = QUALITY.draft;
  const { isoPath } = dolphin.ensureSandbox();
  await killDolphin();

  const spans = clips.map((c) => (c.endFrame - c.startFrame) / 60);
  const totalSec = spans.reduce((a, b) => a + b, 0);

  dolphin.writeRenderConfigs({
    dump: true, internalRes: q.internalRes, bitrateKbps: q.bitrateKbps,
    volume: 0, jukeboxVolume: 0, speed: 0,
  });
  dolphin.clearDump();

  const queueFile = dolphin.writeQueue(
    clips.map((c) => ({ path: c.replay, startFrame: c.startFrame, endFrame: c.endFrame })));
  const { frames: frameDir, audio: audioDir } = dolphin.dumpPaths();
  const wav = path.join(audioDir, "dspdump.wav");
  const avi = path.join(frameDir, "framedump0.avi");

  onProgress?.({ phase: "booting", pct: 0 });
  dolphin.runQueue(queueFile, { isoPath, hidden: true }).catch(() => {});

  const expectBytes = totalSec * WAV_BYTES_PER_SEC;
  let lastSize = -1, lastGrowth = Date.now(), capturing = false;
  const began = Date.now();
  while (true) {
    await sleep(POLL_MS);
    const size = sizeOf(wav);
    if (size > lastSize) {
      if (!capturing && size > 0) capturing = true;
      lastSize = size; lastGrowth = Date.now();
    }
    if (capturing) {
      onProgress?.({ phase: "capturing", pct: Math.min(1, size / expectBytes) });
      if (size >= expectBytes * 0.99) { await sleep(700); break; }
      if (Date.now() - lastGrowth > STALL_MS) break;
    } else if (Date.now() - began > BOOT_TIMEOUT_MS) {
      await killDolphin();
      throw new Error("Dolphin never started capturing");
    }
  }
  await killDolphin();
  if (!fs.existsSync(avi)) throw new Error("Dolphin produced no video dump");

  // Dolphin drops a handful of frames at the start of a capture, so the dump is
  // slightly shorter than the sum of the clips. Spread that over the cuts
  // instead of letting it accumulate into the last clip.
  const capturedSec = sizeOf(wav) / WAV_BYTES_PER_SEC;
  const scale = totalSec > 0 ? Math.min(1, capturedSec / totalSec) : 1;

  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  let at = 0;
  for (const [i, c] of clips.entries()) {
    const from = at * scale;
    const dur = spans[i] * scale;
    at += spans[i];
    const file = path.join(outDir, `${c.key}.mp4`);
    onProgress?.({ phase: "encoding", pct: (i + 1) / clips.length });
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", from.toFixed(3), "-i", avi,
      "-ss", from.toFixed(3), "-i", wav,
      "-t", dur.toFixed(3),
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", `scale=${Math.round(q.height * 4 / 3 / 2) * 2}:${q.height}:flags=bilinear,setsar=1`,
      "-c:v", "libx264", "-preset", q.preset, "-crf", String(q.crf),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", `${q.audioKbps}k`, "-ar", "48000",
      "-movflags", "+faststart",
      file,
    ], { windowsHide: true, maxBuffer: 1 << 24 });
    out.push({ key: c.key, file, bytes: sizeOf(file), durationSec: Math.round(dur * 10) / 10 });
  }
  return out;
}

/** Open a set of clips in Dolphin for on-screen preview - no dumping, no wait. */
export async function previewClips(clips) {
  const { isoPath } = dolphin.ensureSandbox();
  await killDolphin();
  dolphin.writeRenderConfigs({ dump: false });
  const queueFile = dolphin.writeQueue(clips, { realTime: false });
  dolphin.runQueue(queueFile, { isoPath, hidden: false }).catch(() => {});
  return { queued: clips.length };
}
