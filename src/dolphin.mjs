// WOMBO: owns a private sandbox copy of the user's Slippi PLAYBACK Dolphin,
// writes the frame-dump configs, and runs a clip queue headlessly.
//
// The user's real Slippi install is never modified. We copy it once (35MB) and
// point Dolphin at our own User directory with -u, the same way Peppy
// sandboxes the netplay build.
//
// Playback Dolphin takes a "comm file" via -i describing what to play:
//   { mode: "queue", replay: "", isRealTimeMode: false,
//     queue: [ { path, startFrame, endFrame }, ... ] }
// With -b (batch) it exits on its own once the queue is finished, which is what
// makes unattended rendering possible.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APPDATA = process.env.APPDATA;
const SLIPPI_DIR = path.join(APPDATA, "Slippi Launcher");
export const WOMBO_DATA = path.join(APPDATA, "Wombo");

// The app used to be called Clippi, so carry the old data over - settings, the
// clip library and the replay index, which costs minutes to rebuild.
//
// Copy named files rather than renaming the folder. Electron ALSO uses this
// directory for its own caches and creates it before this code runs, so "the
// new folder does not exist yet" is not a usable test; and renaming it races
// the server child, which resolved its paths a moment earlier and will happily
// recreate the old directory underneath you. Copying leaves the old data in
// place as a fallback and is safe to run twice.
const LEGACY_DATA = path.join(APPDATA, "Clippi");
if (fs.existsSync(LEGACY_DATA)) {
  try {
    fs.mkdirSync(WOMBO_DATA, { recursive: true });
    for (const name of ["config.json", "clips.json", "index.json", "clipcache.json", "drafts.json"]) {
      const from = path.join(LEGACY_DATA, name);
      const to = path.join(WOMBO_DATA, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  } catch { /* a locked file just means some of it rebuilds */ }
}
const SANDBOX = path.join(WOMBO_DATA, "playback");

export const EXE = "Slippi Dolphin.exe";

/** Locate the playback build + the Melee ISO from the launcher's own settings. */
export function findSlippi() {
  const settingsPath = path.join(SLIPPI_DIR, "Settings");
  if (!fs.existsSync(settingsPath)) {
    throw new Error("Slippi Launcher not found. Install and run it once first.");
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  const isoPath = settings.settings?.isoPath;
  const playback = path.join(SLIPPI_DIR, "playback");
  if (!fs.existsSync(path.join(playback, EXE))) {
    throw new Error(
      "Slippi's playback Dolphin not found. Watch one replay in the Slippi Launcher, then retry.");
  }
  if (!isoPath || !fs.existsSync(isoPath)) {
    throw new Error("No Melee ISO configured in the Slippi Launcher.");
  }
  return { playback, isoPath };
}

/** Where Slippi saves replays on this PC (from the player's own Dolphin.ini). */
export function replayDir() {
  const ini = path.join(SLIPPI_DIR, "netplay", "User", "Config", "Dolphin.ini");
  try {
    const dir = fs.readFileSync(ini, "utf-8")
      .match(/^SlippiReplayDir\s*=\s*(.+)$/m)?.[1]?.trim();
    if (dir && fs.existsSync(dir)) return path.resolve(dir);
  } catch { /* fall through */ }
  for (const guess of [
    path.join(APPDATA, "..", "Documents", "Slippi"),
    path.join(APPDATA, "..", "OneDrive", "Documents", "Slippi"),
  ]) if (fs.existsSync(guess)) return path.resolve(guess);
  return null;
}

// Copy the playback build into our sandbox (first run / after a Slippi update).
export function ensureSandbox() {
  const { playback, isoPath } = findSlippi();
  const srcExe = path.join(playback, EXE);
  const dstExe = path.join(SANDBOX, EXE);
  const stale = !fs.existsSync(dstExe) ||
    fs.statSync(srcExe).mtimeMs !== fs.statSync(dstExe).mtimeMs;
  if (stale) {
    fs.mkdirSync(WOMBO_DATA, { recursive: true });
    try {
      execFileSync("robocopy", [playback, SANDBOX, "/E", "/XD", "Cache", "Dump",
        "ScreenShots", "Logs", "/NFL", "/NDL", "/NJH", "/NJS"], { stdio: "ignore" });
    } catch (err) {
      if (err.status === undefined || err.status > 7) throw err; // 0-7 = success
    }
  }
  return { sandbox: SANDBOX, isoPath };
}

// --- ini editing -----------------------------------------------------------
// Dolphin rewrites these files itself, so we edit in place rather than
// generating them: unknown keys must survive untouched.
function editIni(file, changes) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split(/\r?\n/) : [];
  const out = [];
  let section = null;
  const pending = new Map(Object.entries(changes).map(([s, kv]) => [s, { ...kv }]));

  const flush = (sec) => {
    const kv = pending.get(sec);
    if (!kv) return;
    for (const [k, v] of Object.entries(kv)) out.push(`${k} = ${v}`);
    pending.delete(sec);
  };

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { flush(section); section = header[1]; out.push(line); continue; }
    const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    const want = kv && pending.get(section);
    if (want && kv[1] in want) {
      out.push(`${kv[1]} = ${want[kv[1]]}`);
      delete want[kv[1]];
      continue;
    }
    out.push(line);
  }
  flush(section);
  for (const [sec, kv] of pending) {          // sections absent from the file
    out.push(`[${sec}]`);
    for (const [k, v] of Object.entries(kv)) out.push(`${k} = ${v}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join("\n"));
}

const B = (v) => (v ? "True" : "False");

/**
 * Point the sandbox at a dump-everything configuration.
 * dump:false restores an interactive setup for on-screen preview playback.
 */
export function writeRenderConfigs({
  dump = true, widescreen = false, internalRes = 2, bitrateKbps = 12000,
  showFrameIndex = false, jukebox = true, volume = 100, jukeboxVolume = 100,
  backend = "Cubeb", speed = 1, chrome = true, audioProbe = false,
} = {}) {
  const cfg = path.join(SANDBOX, "User", "Config");
  editIni(path.join(cfg, "Dolphin.ini"), {
    // Note: DumpAudioSilent/DumpFramesSilent suppress Dolphin's "overwrite the
    // existing dump?" dialog. They have nothing to do with sound output.
    Movie: { DumpFrames: B(dump), DumpFramesSilent: B(dump) },
    DSP: {
      // audioProbe dumps audio WITHOUT dumping frames. The file grows at exactly
      // 128000 bytes/sec while sound is being produced, which is the only
      // reliable way to know the moment playback actually starts - the FPS
      // figure in Dolphin's title turned out to be stuck and useless.
      DumpAudio: B(dump || audioProbe), DumpAudioSilent: B(dump || audioProbe),
      Backend: backend, Volume: volume,
    },
    Display: { Fullscreen: "False", RenderToMain: "True" },
    Interface: {
      ConfirmStop: "False", OnScreenDisplayMessages: B(!dump),
      PauseOnFocusLost: "False",
      // Docked into Wombo, Dolphin should show gameplay and nothing else - its
      // toolbar, status bar and seek bar are replaced by the app's own controls.
      ShowToolbar: B(chrome),
      ShowStatusbar: B(chrome),
      // The seek bar stays ENABLED even in the docked player, because it is the
      // only way to seek in place - re-issuing the replay through the comm file
      // makes Melee reload the match, with the start jingle and a white flash.
      // The app hides the control itself, so it is never drawn.
      ShowSeekbar: "True",
      ShowLogWindow: "False",
      ShowLogConfigWindow: "False",
      // Docked mode: have Dolphin open off-screen so its window never flashes
      // in the middle of the desktop before the app can adopt it. The app moves
      // it into the panel once it has been docked and is ready to show.
      ...(chrome ? {} : { MainWindowPosX: -32000, MainWindowPosY: -32000 }),
    },
    Core: {
      // 0 = uncapped. Frame dumping records every emulated frame regardless of
      // how fast they are produced, so this shortens the render without
      // changing a single frame of the output.
      EmulationSpeed: speed === 0 ? "0.00000000" : speed.toFixed(8),
      SlippiJukeboxEnabled: B(jukebox),
      SlippiJukeboxVolume: jukeboxVolume,
      SlippiPlaybackDisplayFrameIndex: B(showFrameIndex),
    },
    General: { DumpPath: "" },
  });
  editIni(path.join(cfg, "GFX.ini"), {
    Settings: {
      DumpFormat: "avi", DumpCodec: "", BitrateKbps: bitrateKbps,
      InternalResolutionFrameDumps: B(dump), DumpFramesAsImages: "False",
      UseFFV1: "False", wideScreenHack: B(widescreen),
      AspectRatio: widescreen ? 1 : 0,
      ShowFPS: "False", ShowInputDisplay: "False", ShowOSDClock: "False",
      Crop: "False",
    },
    Hardware: { VSync: B(!dump) },
    Enhancements: { InternalResolution: internalRes },
  });
  return { sandbox: SANDBOX, dumpDir: path.join(SANDBOX, "User", "Dump") };
}

export const sandboxDir = () => SANDBOX;

export const dumpPaths = () => ({
  root: path.join(SANDBOX, "User", "Dump"),
  frames: path.join(SANDBOX, "User", "Dump", "Frames"),
  audio: path.join(SANDBOX, "User", "Dump", "Audio"),
});

/** Delete anything left over from a previous dump so we read only fresh files. */
export function clearDump() {
  const { frames, audio } = dumpPaths();
  for (const d of [frames, audio]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Write the playback comm file. queue items are { path, startFrame, endFrame }. */
let commandSeq = 0;

export function writeQueue(queue, { realTime = false, file, overlay = false } = {}) {
  const target = file || path.join(WOMBO_DATA, "queue.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    mode: "queue",
    replay: "",
    // A fresh id every write is what makes Dolphin act on the file NOW.
    // Rewriting the queue under the same commandId is ignored - it looks like
    // the command it is already running - which is why seeking appeared to do
    // nothing. With a new id it drops what it is playing and starts the new
    // queue immediately.
    commandId: `wombo-${Date.now()}-${(commandSeq += 1)}`,
    isRealTimeMode: realTime,
    outputOverlayFiles: overlay,
    queue: queue.map((q) => ({
      path: path.resolve(q.path),
      startFrame: Math.max(-123, Math.round(q.startFrame)),
      endFrame: Math.round(q.endFrame),
    })),
  }, null, 2));
  return target;
}

/**
 * Run one queue to completion. Resolves when Dolphin exits (batch mode).
 * onLine receives Dolphin's stdout/stderr lines for progress reporting.
 */
export function runQueue(queueFile, {
  isoPath, hidden = true, onLine, timeoutMs = 30 * 60_000,
} = {}) {
  const exe = path.join(SANDBOX, EXE);
  const args = ["-i", queueFile, "-b", "-e", isoPath, "-u", path.join(SANDBOX, "User")];
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: SANDBOX,
      windowsHide: hidden,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    const feed = (buf) => {
      if (onLine) String(buf).split(/\r?\n/).forEach((l) => l && onLine(l));
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (killed) reject(new Error("Dolphin render timed out"));
      else resolve(code);
    });
    child.unref?.();
  });
}
