// Wombo as one window: the clip list and Melee side by side.
//
// Electron hosts the same web UI the browser serves, and Dolphin's own window is
// adopted into it (see win32.mjs). The page leaves a hole where the player goes
// and tells us its bounds; we keep Dolphin parked exactly there.
//
// The server is started as a child process rather than imported, so a crash in
// a render cannot take the window down with it.

const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = Number(process.env.WOMBO_PORT ?? 5730);
const ROOT = path.join(__dirname, "..");

let win = null;
let server = null;
let dolphinHwnd = null;
// Whether the page has asked for the player to be on screen. Dolphin re-shows
// itself when emulation starts, so this is what tells the guard to push back.
let playerRevealed = false;
let fitLogs = 0;
let panelPad = 0;
// The stage height the padding has been solved for; 0 means not yet.
let padSolvedFor = 0;
let stageBounds = null;
let dolphinPid = null;
let seekBar = null;
let win32 = null;

// The loaded native module, cached for callers that cannot await - see
// guardHidden, which has to act within a frame of spotting the window.
let w32sync = null;
// Out-of-process window keeper - see shell/keeper.mjs.
let keeper = null;
// Long-lived PowerShell helper that mutes Dolphin's audio session.
let muter = null;
let guardTicks = 0, guardHides = 0;
const bootAt = Date.now();

async function loadWin32() {
  if (!win32) win32 = w32sync = await import("./win32.mjs");
  return win32;
}

// --- the local server ------------------------------------------------------

function startServer() {
  return new Promise((resolve) => {
    server = spawn(process.execPath, [path.join(ROOT, "serve.mjs")], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WOMBO_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const watch = (buf) => {
      const s = String(buf);
      process.stdout.write(s);
      if (s.includes("http://localhost")) resolve();
    };
    server.stdout.on("data", watch);
    server.stderr.on("data", (b) => process.stderr.write(String(b)));
    setTimeout(resolve, 6000);   // resolve anyway; the page retries
  });
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/state`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// --- the window ------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0e1116",
    title: "Wombo",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${PORT}/?shell=1`);
  win.once("ready-to-show", () => win.show());

  // If the preload fails, the page silently falls back to browser behaviour and
  // Dolphin opens in its own window - which looks like the shell "not working".
  // Say so loudly instead.
  win.webContents.on("preload-error", (_e, file, err) => {
    console.error("[shell] PRELOAD FAILED", file, err);
  });
  win.webContents.on("did-finish-load", async () => {
    const seen = await win.webContents.executeJavaScript(
      "({ bridge: typeof window.womboShell, stage: !!document.querySelector('#stage'), transport: !!document.querySelector('#tPlay'), replays: document.querySelectorAll('#replayList li').length })");
    console.log("[shell] renderer sees:", JSON.stringify(seen));
  });

  // Keep Dolphin glued to the hole the page left for it. An owned window does
  // not move with its owner the way a child would, so dragging the app has to
  // reposition it too - not just resizing.
  const reflow = () => { if (dolphinHwnd && stageBounds) placeDolphin(stageBounds); };
  for (const ev of ["resize", "move", "moved", "maximize", "unmaximize", "restore"]) {
    win.on(ev, reflow);
  }
  // Owned windows stay above their owner, so hide it while the app is minimised
  // or it would sit on top of whatever you switched to.
  win.on("minimize", async () => {
    if (!dolphinHwnd) return;
    (await loadWin32()).showWindow(dolphinHwnd, false);
  });
  win.on("restore", async () => {
    if (!dolphinHwnd) return;
    (await loadWin32()).showWindow(dolphinHwnd, true);
  });

  win.on("closed", () => { win = null; });

  // External links (catbox share links) belong in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

/**
 * Park the docked window over the hole the page left for it.
 * The window is owned, not parented, so this works in screen coordinates:
 * content origin + the panel's offset within the page, scaled to real pixels.
 */
async function placeDolphin(bounds) {
  if (!dolphinHwnd || !win) return;
  // Safe even while paused: pause freezes the emulation threads but leaves the
  // window's own thread running, so this cannot block.
  const w32 = await loadWin32();
  try {
    const content = win.getContentBounds();
    const display = screen.getDisplayNearestPoint({ x: content.x, y: content.y });
    const s = display.scaleFactor || 1;
    const box = {
      x: (content.x + bounds.x) * s,
      y: (content.y + bounds.y) * s,
      w: bounds.width * s,
      h: bounds.height * s,
    };
    // Not a plain move: hiding Dolphin's chrome does not give its space back,
    // so the render panel comes out short and the window's grey shows through
    // underneath. fitPanel oversizes the window by exactly that leftover and
    // clips it, leaving the gameplay panel filling the stage.
    w32.fitPanel(dolphinHwnd, box, panelPad);
  } catch (err) {
    console.error("place failed:", err.message);
  }
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle("stage:bounds", async (_e, bounds) => {
  // A new stage height means the padding has to be solved again.
  if (!stageBounds || stageBounds.height !== bounds.height) padSolvedFor = 0;
  stageBounds = bounds;
  tellKeeper(`size ${Math.round(bounds.width)} ${Math.round(bounds.height) + panelPad}`);
  if (dolphinHwnd) await placeDolphin(bounds);
  return { ok: true };
});

/**
 * Adopt the Dolphin window once it exists. The renderer calls this after asking
 * the server to play something; Dolphin takes a few seconds to show a window,
 * so this polls rather than assuming.
 */
async function attachDolphin() {
  if (dolphinHwnd) return { attached: true, already: true };
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/player/hwnd`).then((r) => r.json()).catch(() => null);
    if (res?.hwnd) {
      const w32 = await loadWin32();
      const parent = win.getNativeWindowHandle().readBigUInt64LE(0);
      try {
        w32.showWindow(res.hwnd, false);
        w32.removeMenu(res.hwnd);
        w32.dock(res.hwnd, parent);
        w32.showWindow(res.hwnd, false);
        dolphinHwnd = res.hwnd;
        if (stageBounds) await placeDolphin(stageBounds);
        return { attached: true, hwnd: res.hwnd };
      } catch (err) {
        return { attached: false, error: err.message };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { attached: false, error: "Dolphin never showed a window" };
}

ipcMain.handle("dolphin:attach", attachDolphin);

/**
 * Adopt any Dolphin that turns up, whoever started it.
 *
 * The app and a browser tab both talk to the same server, so a clip played from
 * a stray tab would otherwise open a Dolphin the app never claims - which looks
 * exactly like the embedding being broken. Watching for one removes the whole
 * class of confusion, and also re-adopts after the player is stopped and
 * started again.
 */
function watchForDolphin() {
  setInterval(async () => {
    if (dolphinHwnd || !win) return;
    try {
      // Native lookup, not the server route: that one shells out to PowerShell
      // and costs ~half a second, which is long enough for Dolphin's window to
      // be seen before it can be hidden.
      const w32 = await loadWin32();
      const hwnd = w32.findWindow("Faster Melee");
      if (!hwnd) return;
      // Hide it the instant we find it. Dolphin's window appears early in the
      // ~10s boot, and an owned window floats above the page, so leaving it
      // visible both flashes a second window and covers the app's own "cueing
      // up" panel. It is revealed once the clip is actually playing.
      w32.showWindow(hwnd, false);
      // Alpha 0 as well as hidden: the hide waits on Dolphin's message pump, the
      // alpha does not. This is what actually kills the white box.
      w32.setGhost(hwnd, true);
      w32.removeMenu(hwnd);
      w32.dock(hwnd, win.getNativeWindowHandle().readBigUInt64LE(0));
      w32.showWindow(hwnd, false);
      dolphinHwnd = hwnd;
      // Slippi's seek bar drives in-place seeking and reports the true frame.
      // Keep the control but never show it.
      seekBar = w32.findSeekBar(hwnd);
      if (seekBar) w32.hideSeekStrip(seekBar, hwnd);
      // Park BEFORE anything awaited: fetchPid is an HTTP round trip, and
      // measured, Dolphin self-showed ~340ms after adoption - well inside it.
      // Parking after that call let the flash through anyway.
      await parkOffscreen(hwnd);
      // The keeper has been holding this window down by title since boot; pin
      // it to the exact handle now that there is one.
      tellKeeper('hwnd ' + hwnd);
      dolphinPid = await fetchPid();
      // Silent until the page asks for it: the boot is all menus and noise.
      setDolphinMuted(true);
      win.webContents.send?.("dolphin:adopted");
      console.log("[shell] adopted dolphin window", hwnd);
    } catch { /* nothing to adopt yet */ }
  }, 10);    // as tight as it goes: every poll interval is time it can be seen
}

/** The stage's height in real screen pixels, or 0 if it is not known yet. */
function stageHeightPx() {
  if (!stageBounds || !win) return 0;
  const content = win.getContentBounds();
  const display = screen.getDisplayNearestPoint({ x: content.x, y: content.y });
  return Math.round(stageBounds.height * (display.scaleFactor || 1));
}

/**
 * Work out the padding while the player is still HIDDEN, and wait for it.
 *
 * The background watcher polls at 200ms, and the gap between Dolphin's seek
 * strip existing and the page revealing the player is shorter than that - so
 * the correction always landed a beat after the first frame was on screen, and
 * the band was briefly visible on the first play. Doing it inline here costs up
 * to ~0.6s on the first reveal only, and nothing afterwards.
 */
async function solvePad(want) {
  if (!dolphinHwnd || !want || padSolvedFor === want) return;
  const w32 = await loadWin32();
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 5 && padSolvedFor !== want; i += 1) {
    const got = w32.panelHeight(dolphinHwnd);
    if (!got) return;
    if (Math.abs(got - want) <= 1) {
      if (panelPad > 0) padSolvedFor = want;
      return;
    }
    if (got > want) { await pause(120); continue; }   // layout has not run yet
    const next = Math.min(200, Math.max(0, panelPad + (want - got)));
    if (next === panelPad) { padSolvedFor = want; return; }
    panelPad = next;
    tellKeeper(`size ${Math.round(stageBounds.width)} ${want + panelPad}`);
    if (fitLogs < 12) { fitLogs += 1; console.log("[fit] pre-reveal panel=" + got + " stage=" + want + " pad->" + panelPad); }
    await parkOffscreen();        // apply it off screen, where it cannot be seen
    await pause(150);             // and give wx time to re-run its sizer
  }
}

/**
 * Show or hide the player. The page hides it while a clip is being cued and
 * reveals it once the seek is done, so you never see Dolphin scrub - and never
 * see a second window appear during boot.
 */
ipcMain.handle("dolphin:visible", async (_e, visible) => {
  if (!dolphinHwnd) return { ok: false };
  const w32 = await loadWin32();
  if (visible) {
    // Strip the menu again here, not just at dock time: we now adopt the window
    // within milliseconds of it existing, which is often before wxWidgets has
    // attached its File/Emulation/... bar, so the first strip finds nothing.
    w32.removeMenu(dolphinHwnd);
    // Same story for Dolphin's own seek bar: it does not exist yet at dock
    // time, so find and hide it here. We drive it, but it must never be seen.
    if (!seekBar) seekBar = w32.findSeekBar(dolphinHwnd);
    if (seekBar) w32.hideSeekStrip(seekBar, dolphinHwnd);
    // Solve the padding BEFORE the first frame is on screen, not after.
    await solvePad(stageHeightPx());
    if (stageBounds) await placeDolphin(stageBounds);
  }
  playerRevealed = !!visible;
  setDolphinMuted(!visible);
  tellKeeper(visible ? "reveal" : "hide");
  w32.setGhost(dolphinHwnd, !visible);
  w32.showWindow(dolphinHwnd, !!visible);
  // Hidden means off screen too, so the next self-show has nowhere to flash.
  if (!visible) await parkOffscreen();
  return { ok: true };
});

/**
 * Dolphin shows its own window when emulation starts.
 *
 * Hiding it once at adopt time is not enough: measured, it re-showed itself
 * ~345ms after being adopted and stayed up for ~400ms until the app's reveal
 * placed it - the white box that flashed on first play. So the hide has to be a
 * standing guard rather than a one-shot, holding the window down until the page
 * actually asks for it.
 */
/**
 * Park the player far off screen.
 *
 * Racing Dolphin's own ShowWindow cannot be won - measured, it still won a
 * 250ms window even against a 10ms guard. So instead of fighting over whether
 * it is visible, keep it somewhere nothing can be seen: it is only moved onto
 * the stage at reveal, by which point it is being shown deliberately.
 */
async function parkOffscreen(hwnd = dolphinHwnd) {
  if (!hwnd) return;
  const w32 = await loadWin32();
  // Keep the real size while parked - the window is what Dolphin renders into,
  // and a zero-width one has nothing to draw. Bounds come from the DOM, so they
  // are width/height, not w/h.
  const b = stageBounds || {};
  // Park at the PADDED height. Parking at the bare stage height would let the
  // panel lay out short again on every hide, and the padding would then creep
  // up by that shortfall each time the player was revealed.
  w32.placeScreen(hwnd, {
    x: -32000, y: -32000,
    w: b.width || 1264, h: (b.height || 734) + panelPad,
  });
}

/**
 * Keep the gameplay panel filling the stage.
 *
 * Fitting once at reveal is not enough: wx still reports the panel at full
 * height then, and only lays it out short once Dolphin's seek strip appears -
 * after which a band of window grey sits under the gameplay. Re-checking cheaply
 * catches that, and any later re-layout, without resizing on every frame.
 */
function watchPanelFit() {
  setInterval(async () => {
    if (!dolphinHwnd || !stageBounds || !win) return;
    try {
      const w32 = await loadWin32();
      const content = win.getContentBounds();
      const display = screen.getDisplayNearestPoint({ x: content.x, y: content.y });
      const scale = display.scaleFactor || 1;
      const want = Math.round(stageBounds.height * scale);
      // Solve this ONCE per stage size, then leave it alone.
      //
      // The padding depends on Dolphin's chrome and the stage height, not on
      // what is playing - so there is no reason to keep chasing it, and every
      // reason not to: reloading a replay (what Preview does) makes the panel
      // briefly report a stale height, and resizing on the back of that stalled
      // the renderer for ~3s (fps 32, 4, 0, 0, 47) with the stage black.
      if (padSolvedFor === want) return;
      // Solve this BEFORE the player is ever shown. Dolphin is already playing
      // during cue-up, just hidden and parked off screen, so the whole thing
      // can be measured and corrected there - gating it on playerRevealed meant
      // the band was on screen for a beat before it snapped away.
      //
      // Wait for the seek strip to exist: it is the chrome being compensated
      // for, and mid-boot - with only some controls laid out - the panel reads
      // 20px short instead of 47 and locks in the wrong padding.
      // Look for it here too - it is otherwise only found at reveal, which is
      // exactly the moment this is trying to get ahead of.
      if (!seekBar) {
        seekBar = w32.findSeekBar(dolphinHwnd);
        if (seekBar) w32.hideSeekStrip(seekBar, dolphinHwnd);
        return;
      }
      const st = w32.playbackStats(dolphinHwnd);
      // Running frames at all, not running at full speed: this machine plays
      // back at 43% (fps 25-26) when busy.
      if (!st || !(st.fps >= 20)) return;
      const got = w32.panelHeight(dolphinHwnd);
      if (!got) return;
      if (Math.abs(got - want) <= 1) {
        // Only DONE if padding is what made it fit. Early on - before wx has
        // attached the seek strip - the panel already matches the window, and
        // treating that as solved locked in a padding of zero and let the band
        // come back the moment the strip appeared. Stay armed until a real
        // shortfall actually shows up.
        if (panelPad > 0) padSolvedFor = want;
        return;
      }
      if (got > want) return;               // transitional: layout not run yet
      if (panelPad > 200) {                 // not tracking; stop trying
        padSolvedFor = want;
        return;
      }
      // Feedback, not a one-shot calculation: resizing another process's window
      // is queued until it pumps messages, so a measurement taken straight
      // afterwards returns the old layout. Nudge and re-read.
      const next = Math.min(200, Math.max(0, panelPad + (want - got)));
      if (next === panelPad) { padSolvedFor = want; return; }
      panelPad = next;
      tellKeeper(`size ${Math.round(stageBounds.width * scale)} ${want + panelPad}`);
      if (fitLogs < 12) { fitLogs += 1; console.log("[fit] panel=" + got + " stage=" + want + " pad->" + panelPad); }
      // Apply it now, either way. Recording the padding without resizing left
      // the next measurement unchanged, so the loop had no feedback and the
      // padding ran away (20, 40, 60 ... while the panel sat at 714).
      if (playerRevealed) await placeDolphin(stageBounds);
      else await parkOffscreen();
    } catch (err) {
      if (fitLogs < 12) { fitLogs += 1; console.log("[fit] failed:", err.message); }
    }
  // 200ms, not 500: the padding takes about three adjustments to settle, and
  // at half a second that was still visibly converging after the reveal.
  }, 200);
}

/**
 * Silence Dolphin while it is hidden.
 *
 * Melee makes noise the whole time it boots and walks through the menus, and
 * the cover hides the picture but not the sound - you heard the menu select
 * sound on every first play. Dolphin's own Volume setting only applies at
 * startup, so this mutes the process's Windows audio session instead.
 *
 * The helper is long-lived because it compiles its COM interop on first use,
 * which is far too slow to do at the moment sound needs to stop.
 */
function startMuter() {
  stopMuter();
  muter = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(__dirname, "mute.ps1")], { stdio: ["pipe", "pipe", "pipe"] });
  muter.stdout.on("data", (d) => process.stdout.write("[mute] " + d));
  muter.on("exit", () => { muter = null; });
}

function setDolphinMuted(muted) {
  if (!muter || !dolphinPid) return;
  try { muter.stdin.write(`${muted ? "mute" : "unmute"} ${dolphinPid}\n`); }
  catch { /* helper went away */ }
}

function stopMuter() {
  if (!muter) return;
  try { muter.stdin.write("quit\n"); muter.kill(); } catch { /* already gone */ }
  muter = null;
}
function startKeeper() {
  stopKeeper();
  const b = stageBounds || {};
  keeper = spawn(process.execPath,
    [path.join(__dirname, "keeper.mjs"),
      String(Math.round(b.width || 1264)), String(Math.round(b.height || 734))],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  keeper.stdout.on("data", (d) => process.stdout.write("[keeper] " + d));
  keeper.stderr.on("data", (d) => process.stderr.write("[keeper!] " + d));
  keeper.on("exit", () => { if (keeper) keeper = null; });
}

function tellKeeper(line) {
  try { keeper?.stdin.write(line + "\n"); } catch { /* it went away */ }
}

function stopKeeper() {
  if (!keeper) return;
  try { keeper.stdin.write("quit\n"); keeper.kill(); } catch { /* already gone */ }
}


async function fetchPid() {
  try {
    const { pid } = await fetch(`http://127.0.0.1:${PORT}/api/player/pid`).then((r) => r.json());
    return pid ?? null;
  } catch { return null; }
}

// The pid is cached at adopt time on purpose: looking it up per press cost an
// HTTP round trip plus a tasklist call, which made pause land about a second
// after the click.
let dolphinPaused = false;

ipcMain.handle("dolphin:paused", async (_e, paused) => {
  if (!dolphinHwnd) return { ok: false };
  const w32 = await loadWin32();
  const ok = w32.setPaused(dolphinHwnd, !!paused);
  if (ok) dolphinPaused = !!paused;
  return { ok };
});

/** The true current frame, straight from Slippi's own seek bar. */
ipcMain.handle("dolphin:seekinfo", async () => {
  const w32 = await loadWin32();
  if (!seekBar && dolphinHwnd) {
    seekBar = w32.findSeekBar(dolphinHwnd);
    if (seekBar) w32.hideSeekStrip(seekBar, dolphinHwnd);
  }
  if (!seekBar) return null;
  try { return w32.seekInfo(seekBar); } catch { return null; }
});

/** Seek in place - no reload, so no start jingle and no white flash. */
ipcMain.handle("dolphin:seek", async (_e, frame) => {
  const w32 = await loadWin32();
  if (!seekBar && dolphinHwnd) seekBar = w32.findSeekBar(dolphinHwnd);
  if (!seekBar) return { ok: false };
  try { return { ok: w32.seekTo(seekBar, frame) }; } catch { return { ok: false }; }
});

ipcMain.handle("dolphin:stats", async () => {
  if (!dolphinHwnd) return { running: false };
  const w32 = await loadWin32();
  try { return { running: true, ...w32.playbackStats(dolphinHwnd) }; }
  catch { return { running: false }; }
});

ipcMain.handle("dolphin:focus", async () => {
  if (!dolphinHwnd) return { ok: false };
  const w32 = await loadWin32();
  w32.focus(dolphinHwnd);
  return { ok: true };
});

ipcMain.handle("dolphin:detached", async () => {
  dolphinHwnd = null;         // the player was stopped; forget the handle
  dolphinPid = null;
  seekBar = null;
  dolphinPaused = false;
  return { ok: true };
});

ipcMain.handle("shell:isShell", async () => true);

// --- lifecycle -------------------------------------------------------------

/**
 * WOMBO_SELFTEST=<replay path> drives the whole embed path without a human:
 * play a clip, adopt the window, park it, and report. Used to prove the native
 * window adoption works rather than assuming it does.
 */
/**
 * Reproduce the reported hang: open an auto clip, let its range RUN OUT, then
 * drag the seek bar. Only meaningful inside Electron - a browser tab has no
 * womboShell, so it skips every path this is trying to exercise.
 */
async function seekProbe() {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const log = (...a) => console.log('[seekprobe]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(4000);
    await js(`[...document.querySelectorAll('.tab')].find(t => t.dataset.tab === 'auto').click()`);
    for (let i = 0; i < 90; i++) {
      await wait(1000);
      if (await js(`document.querySelectorAll('#autoRows tr').length`) > 0) break;
    }
    log('opening an auto clip...');
    await js(`document.querySelectorAll('#autoRows tr')[0].click()`);
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      if (await js(`document.querySelector('#stageCover').hidden`)) break;
    }
    log('playing at', await js(`document.querySelector('#tTime').textContent`),
      'range', await js(`document.querySelector('#tRange').textContent`));
    log('letting the clip run out (25s)...');
    await wait(25000);
    log('after it ended: audio bytes',
      await js(`fetch('/api/player/audio').then(r => r.json()).then(j => j.bytes)`));
    log('now dragging the seek bar, as reported...');
    await js(`(() => { const s = document.querySelector('#tSeek');
      s.value = 620;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (let i = 0; i < 45; i++) {
      await wait(1000);
      const covered = await js(`!document.querySelector('#stageCover').hidden`);
      const toast = await js(`document.querySelector('#toast').hidden ? null : document.querySelector('#toast').textContent`);
      if (toast) { log('FAILED after', i + 's:', toast); return; }
      if (!covered && i > 3) {
        log('recovered after', i + 's, clock', await js(`document.querySelector('#tTime').textContent`));
        return;
      }
    }
    log('still covered after 45s - hung');
  } catch (err) { log('threw:', err.message); }
}
async function selfTest() {
  const log = (...a) => console.log("[selftest]", ...a);
  try {
    log("driving the real flow: pick a replay, play, pause, mark in/out");
    const js = (code) => win.webContents.executeJavaScript(code);

    // Step by step, so a stall says which step stalled instead of nothing.
    // The replay list loads asynchronously; picking before it fills finds nothing.
    for (let i = 0; i < 60; i++) {
      const n = await js(`document.querySelectorAll('#replayList li').length`);
      if (n > 0) { log(`replay list populated (${n} rows)`); break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const picked = await js(`(() => {
      const rows = [...document.querySelectorAll('#replayList li')];
      // Needs a real game: newest entries can be aborted ones a few frames long,
      // which show 0:00 and have nothing to play.
      // Pick by the duration element rather than by scraping the row text.
      const dur = (li) => (li.querySelector('.rTop .rMeta')?.textContent || '').trim();
      // No regex: backslash escapes inside this template literal are a trap.
      const secs = (t) => { const p = t.split(':'); return p.length === 2 ? (+p[0]) * 60 + (+p[1]) : 0; };
      const row = rows.find(li => secs(dur(li)) >= 30);
      if (!row) return null;
      row.click();
      return row.textContent.slice(0, 40);
    })()`);
    log("picked replay:", picked);
    if (!picked) { log("RESULT: no replays in the list"); return; }
    await new Promise((r) => setTimeout(r, 500));
    log("total length shown:", await js(`document.querySelector('#tTotal').textContent`));

    await js(`document.querySelector('#tPlay').click()`);
    log("pressed play, waiting for the cover to lift...");
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const hidden = await js(`document.querySelector('#stageCover').hidden`);
      if (hidden) { log(`cover lifted after ${i + 1}s`); break; }
      if (i % 10 === 9) log(`  still covered (${i + 1}s), fps=`,
        JSON.stringify(await js(`window.womboShell.stats()`)));
    }
    const t1 = await js(`document.querySelector('#tTime').textContent`);
    await new Promise((r) => setTimeout(r, 3000));
    const t2 = await js(`document.querySelector('#tTime').textContent`);
    log(`clock: ${t1} -> ${t2}`, t1 !== t2 ? "(running)" : "(STUCK)");

    await js(`document.querySelector('#tPlay').click()`);   // pause
    await new Promise((r) => setTimeout(r, 400));
    const p1 = await js(`document.querySelector('#tTime').textContent`);
    await new Promise((r) => setTimeout(r, 2500));
    const p2 = await js(`document.querySelector('#tTime').textContent`);
    log(`pause: ${p1} -> ${p2}`, p1 === p2 ? "(held)" : "(NOT HELD)");

    // Seeking now goes through Slippi's own seek bar: in place, no reload, so
    // no start jingle and no white flash. Check it lands and keeps playing.
    log("in-place seek via Slippi's seek bar...");
    const before = await js(`window.womboShell.seekInfo()`);
    log("  seek bar reports frame", before?.frame, "range", before?.first + ".." + before?.last);
    const targetFrame = Math.round(before.first + (before.last - before.first) * 0.6);
    const seeked = await js(`window.womboShell.seekTo(${targetFrame})`);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await js(`window.womboShell.seekInfo()`);
    log(`  asked for ${targetFrame}, landed ${after?.frame} (${seeked?.ok ? "ok" : "FAILED"})`);
    log("  cover shown during seek:", await js(`!document.querySelector('#stageCover').hidden`),
      "(false = seamless, no buffering screen)");

    // Seeking while paused used to leave the emulator frozen: clock ran, no
    // sound, nothing on screen. Check the seek recovers from a paused state.
    // input THEN change, the way a real drag fires. Dispatching only 'change'
    // skipped the oninput handler, which is what raises player.seeking - so the
    // test never saw that flag get stuck and the clip buttons greyed out.
    log("seeking while still paused...");
    await js(`(() => { const s = document.querySelector('#tSeek');
      s.value = 300;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await js(`document.querySelector('#stageCover').hidden`)) break;
    }
    const s1 = await js(`document.querySelector('#tTime').textContent`);
    await new Promise((r) => setTimeout(r, 3000));
    const s2 = await js(`document.querySelector('#tTime').textContent`);
    const fpsNow = await js(`window.womboShell.stats()`);
    log(`after seek-while-paused: ${s1} -> ${s2}`, s1 !== s2 ? "(running)" : "(STUCK)",
      "fps=", JSON.stringify(fpsNow?.fps));

    // A disabled button swallows .click() silently, so check before trusting
    // the marks below - this is what a stuck seek flag looks like.
    log("clip buttons after seeking:",
      await js(`!document.querySelector('#tMarkIn').disabled`) ? "enabled" : "GREYED OUT");
    await new Promise((r) => setTimeout(r, 800));
    await js(`document.querySelector('#tMarkIn').click()`);
    // A LONG range on purpose. The 2.5s clip this used to mark finished before
    // anything could go wrong; a real ~15s preview is where the picture died.
    await new Promise((r) => setTimeout(r, 15000));
    await js(`document.querySelector('#tMarkOut').click()`);
    log("range:", await js(`document.querySelector('#tRange').textContent`));
    log("render enabled:", await js(`!document.querySelector('#tRender').disabled`));

    // Preview the marked range: it should play just that span and then stop,
    // hiding the player rather than dropping to Slippi's idle screen.
    log("previewing the marked range...");
    log("preview enabled:", await js(`!document.querySelector('#tPreview').disabled`));
    await js(`document.querySelector('#tPreview').click()`);
    // A preview must NOT reload the replay: reloading is what leaks Melee's
    // menu sound, the garbled load audio and the 'Waiting for game' screen.
    // The buffering cover only appears on the reload path, so it is the tell.
    let reloaded = false;
    for (let i = 0; i < 20; i++) {
      if (await js(`!document.querySelector('#stageCover').hidden`)) { reloaded = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    log("preview reloaded the replay:", reloaded ? "YES - audio/idle-screen will leak" : "no (seeked in place)");
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await js(`document.querySelector('#stageCover').hidden`)) break;
    }
    log("preview playing at", await js(`document.querySelector('#tTime').textContent`));
    // Sample all the way through: a black stage mid-preview means Dolphin has
    // gone idle (queue finished early) while the page still thinks it plays.
    for (let i = 0; i < 20; i++) {
      const clock = await js(`document.querySelector('#tTime').textContent`);
      const st = await js(`window.womboShell.stats()`);
      const covered = await js(`!document.querySelector('#stageCover').hidden`);
      log(`  t+${i}s clock=${clock} fps=${JSON.stringify(st?.fps)} ` +
        `title=${JSON.stringify((st?.title || "").slice(-28))} covered=${covered}`);
      if (covered) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The marked range is ~15s now, so allow for it before calling it stuck.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const txt = await js(`document.querySelector('#stageCoverText').textContent`);
      const shown = await js(`!document.querySelector('#stageCover').hidden`);
      if (shown && txt.includes("finished")) { log("preview ended cleanly:", txt); break; }
      if (i === 59) log("preview did NOT stop at the end of the range");
    }
    // The menu bar kept coming back because we dock before wx attaches it.
    if (dolphinHwnd) {
      const w32 = await loadWin32();
      log("guard: ticks=" + guardTicks + " hides=" + guardHides);
      log("menu bar after reveal:", w32.hasMenu(dolphinHwnd) ? "STILL THERE" : "gone");
      log("seek strip after reveal:", seekBar
        ? JSON.stringify(w32.seekStripHidden(seekBar))
        : "no seek bar found");
    }
    // --- the Auto Clips tab ---------------------------------------------
    // The player is MOVED into this tab rather than duplicated, so the thing
    // to prove is that it still plays here and lands on the suggested range.
    log("switching to Auto Clips...");
    await js(`[...document.querySelectorAll('.tab')].find(t => t.dataset.tab === 'auto').click()`);
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const n = await js(`document.querySelectorAll('#autoRows tr').length`);
      if (n > 0) break;
    }
    log("  suggestions:", await js(`document.querySelector('#autoStatus').textContent`));
    log("  player moved into the tab:",
      await js(`document.querySelector('#playerPane').parentElement.id`));

    // Filters must actually narrow the pool.
    await js(`(() => { const b = document.querySelector('#fTags input[value="zero-to-death"]');
      b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    log("  filtered to 0-to-deaths:", await js(`document.querySelector('#autoShown').textContent`));

    // Dates group three ways, and picking one re-scans rather than filtering
    // the loaded pool - a quiet day's clips never made the global top 4000.
    await js(`document.querySelector('#fGrain .seg[data-grain="month"]').click()`);
    await new Promise((r) => setTimeout(r, 400));
    log("  months offered:",
      await js(`[...document.querySelectorAll('#fDays .fRow')].map(r => r.innerText.trim().replace(/\s+/g, " ")).join(" | ")`));
    await js(`document.querySelector('#fGrain .seg[data-grain="day"]').click()`);
    await new Promise((r) => setTimeout(r, 400));
    // Clicking a suggestion should mark that range and play it.
    await js(`document.querySelector('#autoRows tr').click()`);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await js(`document.querySelector('#stageCover').hidden`)) break;
    }
    log("  playing a suggestion at", await js(`document.querySelector('#tTime').textContent`),
      "range:", await js(`document.querySelector('#tRange').textContent`));
    log("  render enabled from a suggestion:",
      await js(`!document.querySelector('#tRender').disabled`));
    if (dolphinHwnd) {
      const w32b = await loadWin32();
      log("  dolphin visible in auto tab:", w32b.isVisible(dolphinHwnd));
    }
    log("RESULT: flow complete");
    return;
  } catch (err) {
    log("RESULT: threw:", err.message);
    return;
  }
  /* eslint-disable no-unreachable */
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      const rows = [...document.querySelectorAll('#replayList li')];
      // Skip anything still being written - those have no length yet.
      const row = rows.find(li => /\\d:\\d\\d/.test(li.textContent)) || rows[0];
      if (!row) return { error: 'no replays listed' };
      row.click();
      await new Promise(r => setTimeout(r, 400));
      out.totalShown = document.querySelector('#tTotal').textContent;

      document.querySelector('#tPlay').click();
      // Wait for the cover to lift, which means Dolphin is really playing.
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (document.querySelector('#stageCover').hidden) break;
      }
      out.covered = document.querySelector('#stageCover').hidden ? 'lifted' : 'STUCK';

      const t1 = document.querySelector('#tTime').textContent;
      await new Promise(r => setTimeout(r, 3000));
      const t2 = document.querySelector('#tTime').textContent;
      out.clockRuns = t1 !== t2 ? \`yes (\${t1} -> \${t2})\` : \`NO (stuck at \${t1})\`;

      document.querySelector('#tPlay').click();          // pause
      await new Promise(r => setTimeout(r, 500));
      const p1 = document.querySelector('#tTime').textContent;
      await new Promise(r => setTimeout(r, 2500));
      const p2 = document.querySelector('#tTime').textContent;
      out.pauseHolds = p1 === p2 ? \`yes (held at \${p1})\` : \`NO (\${p1} -> \${p2})\`;

      document.querySelector('#tPlay').click();          // resume
      await new Promise(r => setTimeout(r, 800));
      document.querySelector('#tMarkIn').click();
      await new Promise(r => setTimeout(r, 2500));
      document.querySelector('#tMarkOut').click();
      out.range = document.querySelector('#tRange').textContent;
      out.renderEnabled = !document.querySelector('#tRender').disabled;
      return out;
    })()`);
    log("RESULT:", JSON.stringify(r, null, 1));
    return;
  } catch (err) {
    log("RESULT: threw:", err.message);
    return;
  }
}

async function selfTestOld(replay) {
  const log = (...a) => console.log("[selftest]", ...a);
  try {
    // Drive the REAL path: click the button in the page, exactly as a person
    // would. Calling attachDolphin() from here would only prove the native
    // adoption works, not that anything ever asks for it.
    log("clicking a clip's Dolphin button in the page...");
    const clicked = await win.webContents.executeJavaScript(`(async () => {
      // Walk replays until one actually yields clips - the newest games can be
      // mid-write with nothing detected yet.
      const rows = [...document.querySelectorAll('#replayList li')];
      for (const row of rows.slice(0, 25)) {
        row.click();
        await new Promise(r => setTimeout(r, 3000));
        const btn = [...document.querySelectorAll('#clipList .clip button')]
          .find(b => b.textContent.includes('Dolphin'));
        if (btn) { btn.click(); return { ok: true, replay: row.textContent.slice(0, 40) }; }
      }
      return { ok: false, why: 'no replay in the first 25 produced any clips' };
    })()`);
    log("click ->", JSON.stringify(clicked));
    if (!clicked.ok) { log("RESULT: could not click:", clicked.why); return; }

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (dolphinHwnd) {
        log("RESULT: renderer triggered the attach; dolphin hwnd", dolphinHwnd, "is now a child");
        return;
      }
    }
    log("RESULT: the page never attached dolphin - it stayed a separate window");
  } catch (err) {
    log("RESULT: threw:", err.message);
  }
}

app.whenReady().then(async () => {
  await startServer();
  await waitForServer();
  createWindow();
  // Warm and idle before Dolphin exists - spawning it on demand cost ~400ms,
  // which is longer than the flash it is meant to catch.
  startKeeper();
  startMuter();
  watchForDolphin();
  watchPanelFit();
  if (process.env.WOMBO_SEEKPROBE) {
    win.webContents.once("did-finish-load", () => { seekProbe(); });
  } else if (process.env.WOMBO_SELFTEST) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => selfTest(process.env.WOMBO_SELFTEST), 1500);
    });
  }
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", async () => {
  stopKeeper();
  stopMuter();
  // Never leave Dolphin frozen: pause suspends the process, and a quit while
  // paused would strand it suspended with no way back.
  try {
    if (dolphinHwnd) (await loadWin32()).setPaused(dolphinHwnd, false);
  } catch { /* nothing to resume */ }
  // Stop the player and the server rather than leaving orphans behind.
  try { await fetch(`http://127.0.0.1:${PORT}/api/player/stop`, { method: "POST" }); } catch { /* gone */ }
  if (server && !server.killed) server.kill();
});
