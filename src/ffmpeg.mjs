// Finding ffmpeg.
//
// Every render shells out to it, and asking a tester to install it themselves
// was the first thing that stopped one cold - "how do u go about doin this?".
// So a copy ships with the app, and this decides which one to use:
//
//   1. the bundled binary next to the app        (what a released build uses)
//   2. one dropped in the app's data folder      (an escape hatch)
//   3. whatever is on PATH                       (a dev box, or a user's own)
//
// Preferring the bundled copy over PATH is deliberate: it is a known version
// with the encoders we need, so a broken or ancient ffmpeg on someone's PATH
// cannot break rendering.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { WOMBO_DATA } from "./dolphin.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  path.join(HERE, "..", "vendor", "ffmpeg.exe"),
  path.join(WOMBO_DATA, "ffmpeg.exe"),
];

let resolved = null;

/** The ffmpeg to run. Falls back to the bare name, which resolves on PATH. */
export function ffmpegPath() {
  if (resolved) return resolved;
  for (const c of CANDIDATES) {
    try { if (fs.existsSync(c)) return (resolved = c); } catch { /* keep looking */ }
  }
  return (resolved = "ffmpeg");
}

/** True when ffmpeg can actually be run, checked once and remembered. */
let ok = null;
export async function checkFfmpeg() {
  if (ok !== null) return ok;
  try {
    await execFileAsync(ffmpegPath(), ["-version"]);
    ok = true;
  } catch {
    ok = false;
  }
  return ok;
}

/** Which of the three it settled on, for the About/diagnostics line. */
export function ffmpegSource() {
  const p = ffmpegPath();
  if (p === "ffmpeg") return "PATH";
  return p.includes("vendor") ? "bundled" : "app data";
}
