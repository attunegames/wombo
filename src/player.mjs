// A live Dolphin kept alive as a clip player.
//
// Rendering to watch something is backwards: Dolphin is the only thing that can
// play a .slp at all, and booting Melee is the only expensive part (~9s). So
// boot it once and keep it.
//
// The mechanism is the playback comm file, and the important part is commandId:
//
//  - Rewriting the queue under the SAME commandId is ignored. It looks like the
//    command Dolphin is already running, so nothing happens - which is why a
//    seek during playback appeared to do nothing at all.
//  - Rewriting it with a NEW commandId makes Dolphin abandon what it is playing
//    and start the new queue immediately. That is what makes seeking work.
//
// Appending to the queue also works, but only takes effect once the current
// entry finishes - useless while a whole replay is playing. So every play is a
// fresh single-entry queue with a fresh id.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import * as dolphin from "./dolphin.mjs";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  running: false,
  starting: false,
  queueFile: null,
  entries: [],          // the one entry currently commanded
  isoPath: null,
  startedAt: 0,
  lastClip: null,
  played: 0,
};

export function status() {
  return {
    running: state.running && isAlive(),
    starting: state.starting,
    played: state.played,
    lastClip: state.lastClip,
    uptimeSec: state.running ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
  };
}

function isAlive() {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${dolphin.EXE}`], {
      encoding: "utf8", windowsHide: true,
    });
    return out.includes("Slippi Dolphin");
  } catch { return false; }
}

/**
 * Forget any Dolphin left over from a previous run of the server.
 *
 * The queue lives in a file that Dolphin reads by position, so a Dolphin that
 * outlived its server is unreachable: our entry list restarts empty, appends
 * land behind a position it has already passed, and clips silently never play.
 * Killing it on startup is the only state both sides agree on.
 */
export async function reconcile() {
  if (isAlive()) {
    await stop();
    return { killedStale: true };
  }
  return { killedStale: false };
}

/** Boot the player with its first clip. Safe to call when already running. */
export async function start(clip) {
  if (state.starting) throw new Error("The player is already starting up");
  if (state.running && isAlive()) return play(clip);

  state.starting = true;
  try {
    const { isoPath } = dolphin.ensureSandbox();
    state.isoPath = isoPath;
    // Watchable, not recordable: no dumping, real time, sound on.
    // Gameplay only: no toolbar, status bar or seek bar - the app supplies those.
    dolphin.writeRenderConfigs({
      dump: false, internalRes: 2, speed: 1, chrome: false,
      audioProbe: true,   // lets the app tell exactly when sound starts
    });

    // Start the audio probe from nothing, so the first byte written is
    // unambiguously this session's playback.
    try { dolphin.clearDump(); } catch { /* held by a dying Dolphin; harmless */ }

    state.entries = clip ? [entryFor(clip)] : [];
    state.played = clip ? 1 : 0;
    state.queueFile = dolphin.writeQueue(state.entries, {
      file: path.join(dolphin.WOMBO_DATA, "player-queue.json"), overlay: true,
    });
    // Launched hidden: Node's windowsHide puts SW_HIDE in the STARTUPINFO, and
    // wx honours it for the main frame, so the window never appears on the
    // desktop at all. The shell shows it once it has been docked into the panel.
    dolphin.runQueue(state.queueFile, {
      isoPath, hidden: true, timeoutMs: 6 * 60 * 60_000,
    }).catch(() => { state.running = false; });

    state.running = true;
    state.startedAt = Date.now();
    state.lastClip = clip ?? null;
    return { started: true, booting: true };
  } finally {
    state.starting = false;
  }
}

const entryFor = (c) => ({
  path: c.replay, startFrame: c.startFrame, endFrame: c.endFrame,
});

/**
 * Show a clip now, replacing whatever is playing. Boots the player if needed.
 *
 * This REPLACES the queue rather than appending to it. Appending was the old
 * approach and it only ever took effect once Dolphin went idle, so a seek issued
 * during a replay sat behind minutes of playback and looked like nothing had
 * happened. writeQueue stamps a fresh commandId, which is what makes Dolphin
 * abandon what it is playing and start this instead.
 */
export async function play(clip) {
  if (!clip?.replay) throw new Error("A clip needs a replay path");
  if (!state.running || !isAlive()) {
    state.running = false;
    return start(clip);
  }
  state.entries = [entryFor(clip)];
  state.played += 1;
  dolphin.writeQueue(state.entries, { file: state.queueFile });
  state.lastClip = clip;
  return { started: false, immediate: true };
}

/** Bring the player window to the front so the clip is actually visible. */
export async function focus() {
  const ps = `
$p = Get-Process | Where-Object { $_.ProcessName -like '*Dolphin*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
  [void][Fg]::ShowWindow($p.MainWindowHandle, 9)
  [void][Fg]::SetForegroundWindow($p.MainWindowHandle)
  Write-Output "ok"
}`;
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps],
      { windowsHide: true });
    return { focused: stdout.trim() === "ok" };
  } catch { return { focused: false }; }
}

/**
 * The player window's handle, or null if it has not appeared yet.
 * Discovery goes through PowerShell because it happens once per boot; the
 * shell then drives the window with direct user32 calls, which have to keep up
 * with a dragged window edge.
 */
export async function hwnd() {
  const ps = `
$p = Get-Process | Where-Object { $_.ProcessName -like '*Dolphin*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { Write-Output $p.MainWindowHandle }`;
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps],
      { windowsHide: true });
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** Where the player window is, so a UI can sit against it. */
export async function windowRect() {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Wr {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$p = Get-Process | Where-Object { $_.ProcessName -like '*Dolphin*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  $r = New-Object Wr+RECT
  [void][Wr]::GetWindowRect($p.MainWindowHandle, [ref]$r)
  Write-Output ("{0},{1},{2},{3}" -f $r.L, $r.T, ($r.R-$r.L), ($r.B-$r.T))
}`;
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps],
      { windowsHide: true });
    const [x, y, w, h] = stdout.trim().split(",").map(Number);
    return Number.isFinite(x) ? { x, y, w, h } : null;
  } catch { return null; }
}

/** Move/resize the player window - used to dock it beside the clip list. */
export async function placeWindow({ x, y, w, h }) {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mv { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool r); }
"@
$p = Get-Process | Where-Object { $_.ProcessName -like '*Dolphin*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { [void][Mv]::MoveWindow($p.MainWindowHandle, ${x}, ${y}, ${w}, ${h}, $true); Write-Output "ok" }`;
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps],
      { windowsHide: true });
    return { placed: stdout.trim() === "ok" };
  } catch { return { placed: false }; }
}

/** Dolphin's process id, so the shell can freeze it for a pause. */
export function pid() {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${dolphin.EXE}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8", windowsHide: true,
    }).trim();
    const n = Number(out.split(",")[1]?.replace(/"/g, ""));
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/**
 * Play a whole replay, so it can be watched and marked up.
 * This is the main flow: watch, mark a start and an end, render that range.
 */
export async function playReplay(file, { fromFrame = -123, lastFrame } = {}) {
  return play({
    replay: file,
    startFrame: fromFrame,
    endFrame: lastFrame ?? 999999,
    label: null,
  });
}

/**
 * Bytes of audio Dolphin has produced so far.
 *
 * This is the readiness signal: the file only grows while sound is actually
 * being output, so the first byte past a baseline is the instant playback
 * becomes audible - which is precisely when the picture needs to appear.
 */
export function audioBytes() {
  try {
    return fs.statSync(path.join(dolphin.dumpPaths().audio, "dspdump.wav")).size;
  } catch { return 0; }
}

export async function stop() {
  try {
    await execFileAsync("taskkill", ["/F", "/IM", dolphin.EXE], { windowsHide: true });
  } catch { /* not running */ }
  await sleep(400);
  state.running = false;
  state.entries = [];
  state.played = 0;
  state.lastClip = null;
  return { stopped: true };
}
