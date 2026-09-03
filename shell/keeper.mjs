// Holds Dolphin's window off screen until the app says otherwise.
//
// This is a separate process on purpose, started BEFORE Dolphin exists.
// Dolphin shows its own window ~300ms after we adopt it, and restores its saved
// geometry when it does - landing it at 0,0 as a white box. Two things stop
// that from being caught in-process: Electron's main thread is busy enough
// during startup that a 5ms interval only ticked 305 times where it should have
// ticked ~840, and spawning this helper on demand costs ~400ms of Node plus
// koffi startup - longer than the race itself. So it is launched at app boot,
// warm and idle, and finds the window on its own.
//
// Commands arrive on stdin, one per line:
//   reveal   - stop holding it down (the app is about to show it deliberately)
//   hide     - resume holding
//   hwnd N   - pin to this exact window instead of matching by title
//   size W H - the size to park it at
//   quit
import { createRequire } from "node:module";
const koffi = createRequire(import.meta.url)("koffi");
const u = koffi.load("user32.dll");
const HWND = koffi.pointer("HKEEP", koffi.opaque());
const Cb = koffi.proto("bool __stdcall CbKeep(HKEEP h, intptr p)");
const EnumWindows = u.func("bool __stdcall EnumWindows(CbKeep* cb, intptr l)");
const GetWindowTextW = u.func("int __stdcall GetWindowTextW(HKEEP h, _Out_ uint16_t *b, int n)");
const GetClassNameW = u.func("int __stdcall GetClassNameW(HKEEP h, _Out_ uint16_t *b, int n)");
const EnumChildWindows = u.func("bool __stdcall EnumChildWindows(HKEEP p, CbKeep* cb, intptr l)");
const GetParent = u.func("HKEEP __stdcall GetParent(HKEEP h)");
const GetWindowRect = u.func("bool __stdcall GetWindowRect(HKEEP h, _Out_ int32 *r)");
const ShowWindow = u.func("bool __stdcall ShowWindow(HKEEP h, int n)");
const MoveWindow = u.func("bool __stdcall MoveWindow(HKEEP h, int x, int y, int w, int h, bool r)");
const IsWindowVisible = u.func("bool __stdcall IsWindowVisible(HKEEP h)");
const IsWindow = u.func("bool __stdcall IsWindow(HKEEP h)");

let w = Number(process.argv[2]) || 1264;
let h = Number(process.argv[3]) || 734;
let holding = true;
let hides = 0;
let pinned = null;          // set once the app has adopted a window

/** The player window, by title, until the app pins one by handle. */
let found = null;
// Registered ONCE. koffi.register builds a trampoline per call, and doing that
// inside a 2ms tick cost more than the interval itself - the guard ended up
// sampling far slower than it looked.
const enumCb = koffi.register((hw) => {
  const b = new Uint16Array(160);
  const n = GetWindowTextW(hw, b, 160);
  if (n && Buffer.from(b.buffer, 0, n * 2).toString("utf16le").includes("Faster Melee")) {
    found = koffi.address(hw);   // the pointer is only valid inside the callback
    return false;
  }
  return true;
}, koffi.pointer(Cb));

function findPlayer() {
  found = null;
  EnumWindows(enumCb, 0);
  return found ? koffi.as(BigInt(found), HWND) : null;
}

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const [cmd, a, b] = buf.slice(0, i).trim().split(/\s+/);
    buf = buf.slice(i + 1);
    if (cmd === "reveal") holding = false;
    else if (cmd === "hwnd") pinned = koffi.as(BigInt(a), HWND);
    else if (cmd === "hide") holding = true;
    else if (cmd === "size") { w = Number(a) || w; h = Number(b) || h; }
    else if (cmd === "quit") process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));

// --- Dolphin's own chrome ---------------------------------------------------
//
// The seek bar lives in a panel that also draws Dolphin's elapsed/total clock
// and a line of keyboard hints. Hiding it once when the player is revealed is
// not enough - Dolphin puts it back - so it is held down here, every tick, the
// same way the window is.
const CHROME = ["msctls_statusbar32", "toolbarwindow32"];
let strip = [];        // addresses of the chrome to keep hidden
let scanned = 0;
let reflowed = 0;

let childHits = [];
const childCb = koffi.register((hw) => {
  const b = new Uint16Array(96);
  const n = GetClassNameW(hw, b, 96);
  const cls = n ? Buffer.from(b.buffer, 0, n * 2).toString("utf16le").toLowerCase() : "";
  if (cls === "msctls_trackbar32") {
    // The slider itself, and the panel around it that carries the clock.
    childHits.push(koffi.address(hw));
    const par = GetParent(hw);
    if (par) childHits.push(koffi.address(par));
  } else if (CHROME.includes(cls)) {
    childHits.push(koffi.address(hw));
  }
  return true;
}, koffi.pointer(Cb));

function findChrome(win) {
  childHits = [];
  EnumChildWindows(win, childCb, 0);
  return childHits;
}

/** Keep Dolphin's own chrome hidden, and re-flow the window when we hide it. */
function holdChrome(win) {
  // Re-scan now and then: the controls do not all exist when the window does.
  if (!strip.length || Date.now() - scanned > 1000) {
    const found = findChrome(win);
    if (found.length) strip = found;
    scanned = Date.now();
  }
  let hidAny = false;
  for (const addr of strip) {
    const h = koffi.as(BigInt(addr), HWND);
    if (!IsWindow(h) || !IsWindowVisible(h)) continue;
    ShowWindow(h, 0);
    hidAny = true;
  }
  // Re-flowing the window is the shell's job (win32 fitPanel) - doing it here
  // as well resized the window continuously and the renderer never settled.
  void hidAny;
}

const tick = () => {
  if (pinned && !IsWindow(pinned)) { pinned = null; strip = []; }
  const target = pinned || findPlayer();
  if (!target) return;
  holdChrome(target);
  if (!holding || !IsWindowVisible(target)) return;
  ShowWindow(target, 0);                         // SW_HIDE
  // It restores its saved geometry when it shows itself, so re-park too.
  MoveWindow(target, -32000, -32000, w, h, false);
  hides += 1;
  process.stdout.write("hide #" + hides + String.fromCharCode(10));
};

setInterval(tick, 2);
