// Putting Dolphin's window inside ours.
//
// Windows lets you adopt another process's top-level window as a child of your
// own with SetParent. Once adopted it stops being a separate taskbar entry and
// lives wherever we put it, so Wombo becomes one window with the clip list on
// one side and Melee playing on the other.
//
// Two details make or break it:
//  - A window keeps WS_POPUP/WS_CAPTION after adoption and would still draw its
//    own title bar and border inside our panel, so the style has to be rewritten
//    to WS_CHILD before it looks like part of the app.
//  - After SetParent the coordinates are relative to US, not the screen.
//
// koffi is used rather than shelling out to PowerShell because resize has to
// keep up with a dragged window edge; a process spawn per frame does not.

import koffi from "koffi";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const ntdll = koffi.load("ntdll.dll");

// Declared up here because the kernel32 helpers below reference it.
const HWND = koffi.pointer("HWND", koffi.opaque());

const HPROC = koffi.pointer("HPROC", koffi.opaque());
const OpenProcess = kernel32.func("HPROC __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(HPROC h)");
const NtSuspendProcess = ntdll.func("int32 __stdcall NtSuspendProcess(HPROC h)");
const NtResumeProcess = ntdll.func("int32 __stdcall NtResumeProcess(HPROC h)");
const PROCESS_SUSPEND_RESUME = 0x0800;

const TH32CS_SNAPTHREAD = 0x00000004;
const THREAD_SUSPEND_RESUME = 0x0002;
const THREADENTRY32 = koffi.struct("THREADENTRY32", {
  dwSize: "uint32", cntUsage: "uint32", th32ThreadID: "uint32",
  th32OwnerProcessID: "uint32", tpBasePri: "int32", tpDeltaPri: "int32",
  dwFlags: "uint32",
});
const CreateToolhelp32Snapshot = kernel32.func("HPROC __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)");
const Thread32First = kernel32.func("bool __stdcall Thread32First(HPROC snap, _Inout_ THREADENTRY32 *e)");
const Thread32Next = kernel32.func("bool __stdcall Thread32Next(HPROC snap, _Inout_ THREADENTRY32 *e)");
const OpenThread = kernel32.func("HPROC __stdcall OpenThread(uint32 access, bool inherit, uint32 tid)");
const SuspendThread = kernel32.func("uint32 __stdcall SuspendThread(HPROC t)");
const ResumeThread = kernel32.func("uint32 __stdcall ResumeThread(HPROC t)");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(HWND h, _Out_ uint32 *pid)");

/**
 * Pause and resume Dolphin by freezing its emulation threads.
 *
 * Dolphin's own pause hotkey cannot be reached: it ignores posted WM_KEYDOWN
 * and also ignores real system-level injection (keybd_event) even with the
 * window in the foreground - verified with two different keys. Freezing it from
 * outside is the only way in.
 *
 * It must NOT be the whole process. NtSuspendProcess freezes Dolphin's GUI
 * thread too, and its window is owned by ours, so Windows has to talk to that
 * frozen window whenever anything touches it - z-order, activation, a title
 * read. Those calls are synchronous and never return, which hangs Wombo
 * itself. Leaving the window's own thread running keeps it answering messages
 * while the emulator stops dead.
 */
export function setPaused(hwnd, paused) {
  const pidOut = [0];
  const guiThread = GetWindowThreadProcessId(asHandle(hwnd), pidOut);
  const pid = pidOut[0];
  if (!pid || !guiThread) return false;

  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (!snap) return false;
  const entry = { dwSize: 28, cntUsage: 0, th32ThreadID: 0, th32OwnerProcessID: 0,
    tpBasePri: 0, tpDeltaPri: 0, dwFlags: 0 };
  let touched = 0;
  try {
    let ok = Thread32First(snap, entry);
    while (ok) {
      if (entry.th32OwnerProcessID === pid && entry.th32ThreadID !== guiThread) {
        const t = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID);
        if (t) {
          if (paused) SuspendThread(t); else ResumeThread(t);
          CloseHandle(t);
          touched++;
        }
      }
      entry.dwSize = 28;
      ok = Thread32Next(snap, entry);
    }
  } finally {
    CloseHandle(snap);
  }
  return touched > 0;
}


const SetParent = user32.func("HWND __stdcall SetParent(HWND hWndChild, HWND hWndNewParent)");
const MoveWindow = user32.func("bool __stdcall MoveWindow(HWND h, int x, int y, int w, int ht, bool repaint)");
const ShowWindow = user32.func("bool __stdcall ShowWindow(HWND h, int nCmdShow)");
const SetWindowLongPtr = user32.func("int64 __stdcall SetWindowLongPtrW(HWND h, int nIndex, int64 dwNewLong)");
const GetWindowLongPtr = user32.func("int64 __stdcall GetWindowLongPtrW(HWND h, int nIndex)");
const SetFocus = user32.func("HWND __stdcall SetFocus(HWND h)");
const SetWindowPos = user32.func("bool __stdcall SetWindowPos(HWND h, HWND after, int x, int y, int cx, int cy, uint32 flags)");

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_SYSMENU = 0x00080000;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_TOOLWINDOW = 0x00000080;

const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

const asHandle = (n) => koffi.as(BigInt(n), HWND);

/**
 * Dock a window against ours so it looks like a panel of the app.
 *
 * NOT SetParent. Making Dolphin a child of the Electron window works at the
 * Win32 level - it parents, positions and reports visible - but nothing ever
 * appears, because Chromium renders through DirectComposition straight into the
 * top-level window and that surface composites over native child windows. You
 * get audio and a black panel.
 *
 * Setting Wombo as the OWNER instead keeps Dolphin a top-level window with its
 * own render surface, so it actually draws, while Windows guarantees it stays
 * above its owner and minimises and restores with it. WS_EX_TOOLWINDOW keeps it
 * out of the taskbar and alt-tab, so it reads as part of the app rather than a
 * second program.
 */
export function dock(childHwnd, ownerHwnd) {
  const child = asHandle(childHwnd);

  // Visibility is left to the caller: the window is launched hidden and only
  // shown once it is parked in the panel, so docking must not reveal it.
  const style = GetWindowLongPtr(child, GWL_STYLE);
  const stripped = (BigInt(style)
    & ~BigInt(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_CHILD))
    | BigInt(WS_POPUP);
  SetWindowLongPtr(child, GWL_STYLE, stripped);

  const ex = GetWindowLongPtr(child, GWL_EXSTYLE);
  SetWindowLongPtr(child, GWL_EXSTYLE,
    (BigInt(ex) & ~BigInt(WS_EX_APPWINDOW)) | BigInt(WS_EX_TOOLWINDOW));

  // Owner, not parent: coordinates stay in screen space and the surface is ours.
  SetWindowLongPtr(child, GWLP_HWNDPARENT, BigInt(ownerHwnd));

  SetWindowPos(child, koffi.as(0n, HWND), 0, 0, 0, 0,
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | 0x0002 | 0x0001);
  return true;
}

/** Position a docked window. Coordinates are in SCREEN pixels. */
export function placeScreen(childHwnd, { x, y, w, h }) {
  return MoveWindow(asHandle(childHwnd), Math.round(x), Math.round(y),
    Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), true);
}

/** Adopt `childHwnd` into `parentHwnd` and strip its window chrome. */
export function embed(childHwnd, parentHwnd) {
  const child = asHandle(childHwnd);
  const parent = asHandle(parentHwnd);

  const style = GetWindowLongPtr(child, GWL_STYLE);
  const stripped = (BigInt(style)
    & ~BigInt(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU))
    | BigInt(WS_CHILD | WS_VISIBLE);
  SetWindowLongPtr(child, GWL_STYLE, stripped);

  const ex = GetWindowLongPtr(child, GWL_EXSTYLE);
  SetWindowLongPtr(child, GWL_EXSTYLE,
    (BigInt(ex) & ~BigInt(WS_EX_APPWINDOW)) | BigInt(WS_EX_TOOLWINDOW));

  SetParent(child, parent);
  SetWindowPos(child, koffi.as(0n, HWND), 0, 0, 0, 0,
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  ShowWindow(child, 5); // SW_SHOW
  return true;
}

/** Position the embedded window. Coordinates are relative to the parent. */
export function place(childHwnd, { x, y, w, h }) {
  return MoveWindow(asHandle(childHwnd), Math.round(x), Math.round(y),
    Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), true);
}

const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(HWND h, _Out_ uint16_t *buf, int max)");
const SetMenu = user32.func("bool __stdcall SetMenu(HWND h, HWND menu)");
const GetMenu = user32.func("HWND __stdcall GetMenu(HWND h)");
const DrawMenuBar = user32.func("bool __stdcall DrawMenuBar(HWND h)");

/**
 * Strip Dolphin's File/Emulation/Movie/... menu bar.
 *
 * There is no setting for this - unlike the toolbar, status bar and seek bar,
 * the menu is a real Win32 menu attached to the frame, so it has to be detached
 * from the window rather than switched off in the ini.
 */
/** Does the window still have a menu bar attached? */
export function hasMenu(childHwnd) {
  return !!GetMenu(asHandle(childHwnd));
}

export function removeMenu(childHwnd) {
  const h = asHandle(childHwnd);
  SetMenu(h, koffi.as(0n, HWND));
  DrawMenuBar(h);
  return true;
}

/**
 * Dolphin's own title, which is the only live telemetry it exposes:
 *   ... | HLE | FPS: 60 - VPS: 60 - 100%
 * The percentage is emulation speed, and it is the signal that tells us whether
 * Dolphin is still fast-forwarding to the start of a clip or actually playing
 * it - there is no status file, and outputOverlayFiles writes nothing in this
 * build.
 */
export function title(childHwnd) {
  const buf = new Uint16Array(512);
  const n = GetWindowTextW(asHandle(childHwnd), buf, 512);
  if (!n) return "";
  return Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
}

/** { fps, vps, speed } parsed out of the title, or nulls when not playing. */
export function playbackStats(childHwnd) {
  const t = title(childHwnd);
  const m = /FPS:\s*([\d.]+)\s*-\s*VPS:\s*([\d.]+)\s*-\s*([\d.]+)%/.exec(t);
  if (!m) return { fps: null, vps: null, speed: null, title: t };
  return { fps: +m[1], vps: +m[2], speed: +m[3], title: t };
}

const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(HWND h, intptr p)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumWindowsProc* cb, intptr l)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(HWND h)");

/** Diagnostic: is the seek-bar strip (slider AND its panel) off screen? */
export function seekStripHidden(barHwnd) {
  const bar = asHandle(barHwnd);
  const parent = GetParent(bar);
  return {
    slider: !IsWindowVisible(bar),
    panel: parent ? !IsWindowVisible(parent) : null,
  };
}

const SetLayeredWindowAttributes = user32.func(
  "bool __stdcall SetLayeredWindowAttributes(HWND h, uint32 key, uint8 alpha, uint32 flags)");
const WS_EX_LAYERED = 0x00080000;
const LWA_ALPHA = 0x00000002;

/**
 * Make the window compositionally invisible - or bring it back.
 *
 * Hiding is not enough on its own. ShowWindow on another process's window only
 * takes effect when THAT process pumps messages, and Dolphin's GUI thread is
 * busy booting a game at exactly the moment it shows itself, so the hide lands
 * late no matter how fast we ask. Alpha is handled by the compositor instead,
 * so it applies whether or not Dolphin is listening.
 */
export function setGhost(hwnd, ghost) {
  const h = asHandle(hwnd);
  const ex = BigInt(GetWindowLongPtr(h, GWL_EXSTYLE));
  if (ghost) {
    SetWindowLongPtr(h, GWL_EXSTYLE, ex | BigInt(WS_EX_LAYERED));
    return SetLayeredWindowAttributes(h, 0, 0, LWA_ALPHA);
  }
  // Opaque first, then drop the style, so it never flickers through a partly
  // composited state on the way back.
  SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA);
  SetWindowLongPtr(h, GWL_EXSTYLE, ex & ~BigInt(WS_EX_LAYERED));
  return true;
}

const GetWindowRect = user32.func("bool __stdcall GetWindowRect(HWND h, _Out_ int32 *r)");
const gdi32 = koffi.load("gdi32.dll");
const CreateRectRgn = gdi32.func("HWND __stdcall CreateRectRgn(int l, int t, int r, int b)");
const SetWindowRgn = user32.func("int __stdcall SetWindowRgn(HWND h, HWND rgn, bool redraw)");
const EnumChildWindows2 = user32.func("bool __stdcall EnumChildWindows(HWND p, EnumWindowsProc* cb, intptr l)");
const GetClassNameW2 = user32.func("int __stdcall GetClassNameW(HWND h, _Out_ uint16_t *b, int n)");
const GetParent2 = user32.func("HWND __stdcall GetParent(HWND h)");

/** The panel Dolphin renders into: its largest direct child. */
function renderPanel(hwnd) {
  const top = asHandle(hwnd);
  // Not koffi.address(top): that rejects a koffi.as() cast. The caller's own
  // handle value IS the address, and addresses come back as Number or BigInt
  // depending on the call, so compare them as strings.
  const topAddr = String(BigInt(hwnd));
  let best = null;
  const cb = koffi.register((h) => {
    const par = GetParent2(h);
    if (!par || String(koffi.address(par)) !== topAddr) return true;
    const b = new Uint16Array(64);
    const n = GetClassNameW2(h, b, 64);
    const cls = n ? Buffer.from(b.buffer, 0, n * 2).toString("utf16le") : "";
    if (!cls.startsWith("wxWindow")) return true;
    const r = [0, 0, 0, 0];
    if (!GetWindowRect(h, r)) return true;
    const area = (r[2] - r[0]) * (r[3] - r[1]);
    if (!best || area > best.area) best = { area, w: r[2] - r[0], h: r[3] - r[1] };
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumChildWindows2(top, cb, 0); } finally { koffi.unregister(cb); }
  return best;
}

/**
 * Put the render panel exactly over the stage, and clip everything else away.
 *
 * Hiding Dolphin's toolbar, status bar and seek strip does not give their space
 * back: wx still lays the render panel out short (measured 1264x687 inside a
 * 734-tall window), and the leftover band shows the window's own grey. Rather
 * than fight the sizer, the window is made TALLER by exactly that leftover - so
 * the panel comes out stage-sized - and then clipped to the stage, which throws
 * the chrome band away entirely.
 */
export function panelHeight(hwnd) {
  const p = renderPanel(hwnd);
  return p ? p.h : 0;
}

export function fitPanel(hwnd, { x, y, w, h }, pad = 0) {
  const child = asHandle(hwnd);
  const X = Math.round(x), Y = Math.round(y);
  const W = Math.max(2, Math.round(w)), H = Math.max(2, Math.round(h));
  const P = Math.max(0, Math.round(pad));
  // Two halves to one problem. Dolphin lays its render panel out SHORTER than
  // the window (it keeps reserving space for chrome we hid), so the window is
  // made taller by `pad` until the panel comes out stage-sized - and then
  // clipped back to the stage, which throws the reserved band away instead of
  // showing it as a bar under the gameplay.
  //
  // `pad` is not measured here: resizing another process's window is queued
  // until IT pumps messages, so reading the layout straight afterwards returns
  // the old numbers. The caller converges it over a few ticks instead.
  MoveWindow(child, X, Y, W, H + P, true);
  SetWindowRgn(child, CreateRectRgn(0, 0, W, H), true);
  return true;
}

/** Is the window currently on screen? */
export function isVisible(hwnd) {
  return !!IsWindowVisible(asHandle(hwnd));
}

/**
 * Find Dolphin's window by title, natively.
 *
 * Worth doing here rather than asking the server: that route shells out to
 * PowerShell, which costs 400-500ms, and the whole point is to hide the window
 * before it can be seen. This runs in microseconds, so it can be polled tightly.
 */
export function findWindow(titleContains) {
  let found = 0;
  const cb = koffi.register((h) => {
    // Deliberately not filtering on visibility: Dolphin is launched hidden, and
    // this has to find it in that state to dock it before it is ever shown.
    const buf = new Uint16Array(320);
    const n = GetWindowTextW(h, buf, 320);
    if (n) {
      const t = Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
      if (t.includes(titleContains)) { found = Number(koffi.address(h)); return false; }
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return found || null;
}

/** Show or hide the docked window - it must not linger over other apps. */
export function showWindow(childHwnd, visible) {
  return ShowWindow(asHandle(childHwnd), visible ? 5 : 0);  // SW_SHOW / SW_HIDE
}

/** Hand keyboard focus to the embedded window so its hotkeys work. */
export function focus(childHwnd) {
  SetFocus(asHandle(childHwnd));
}

/** Give a window back its own frame - used when detaching on shutdown. */
export function release(childHwnd) {
  const child = asHandle(childHwnd);
  SetParent(child, koffi.as(0n, HWND));
  const style = GetWindowLongPtr(child, GWL_STYLE);
  SetWindowLongPtr(child, GWL_STYLE,
    (BigInt(style) & ~BigInt(WS_CHILD)) | BigInt(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU));
  SetWindowPos(child, koffi.as(0n, HWND), 0, 0, 0, 0,
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

// --- Slippi's own seek bar -------------------------------------------------
// The playback build has a standard msctls_trackbar32 whose range is frames and
// whose position is the live current frame. Driving it seeks IN PLACE, with no
// match reload - so no start jingle and no white flash, unlike re-issuing the
// replay through the comm file. It also gives a real position readout, which is
// far better than deriving one from the wall clock.
//
// It only takes real mouse input. TBM_SETPOS plus a WM_HSCROLL notification is
// ignored (playback rewrites the thumb every frame, and wx reads the control,
// not the message). A press-drag-release on the control itself works.

const EnumChildWindows = user32.func("bool __stdcall EnumChildWindows(HWND p, EnumWindowsProc* cb, intptr l)");
const GetClassNameW = user32.func("int __stdcall GetClassNameW(HWND h, _Out_ uint16_t *b, int n)");
const GetClientRect = user32.func("bool __stdcall GetClientRect(HWND h, _Out_ int32 *r)");
const SendMessageW = user32.func("intptr __stdcall SendMessageW(HWND h, uint32 m, uintptr w, intptr l)");

const TBM_GETPOS = 0x0400, TBM_GETRANGEMIN = 0x0401, TBM_GETRANGEMAX = 0x0402;
const WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_MOUSEMOVE = 0x0200;
const lparam = (x, y) => ((y & 0xffff) << 16) | (x & 0xffff);

const GetParent = user32.func("HWND __stdcall GetParent(HWND h)");

/**
 * Hide the whole seek-bar strip, not just the slider.
 *
 * The slider sits in a panel that also carries Dolphin's own elapsed/total time
 * and a line of keyboard hints - hiding only the slider leaves that strip on
 * screen, showing a second clock under ours. Hiding the parent takes the lot.
 * The slider still accepts our messages while hidden.
 */
export function hideSeekStrip(barHwnd, rootHwnd) {
  const bar = asHandle(barHwnd);
  const parent = GetParent(bar);
  // Never hide the parent if it IS the player window - that would black out the
  // whole stage rather than a strip along its bottom.
  const root = rootHwnd == null ? 0n : BigInt(rootHwnd);
  if (parent && (!root || koffi.address(parent) !== root)) ShowWindow(parent, 0);
  ShowWindow(bar, 0);                          // SW_HIDE
  return true;
}

/** The seek bar inside the player window, or null. */
export function findSeekBar(mainHwnd) {
  let bar = 0;
  const cb = koffi.register((h) => {
    const b = new Uint16Array(64);
    const n = GetClassNameW(h, b, 64);
    if (Buffer.from(b.buffer, 0, n * 2).toString("utf16le") === "msctls_trackbar32") {
      bar = Number(koffi.address(h));
      return false;
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumChildWindows(asHandle(mainHwnd), cb, 0); } finally { koffi.unregister(cb); }
  return bar || null;
}

/** { frame, first, last } straight from the seek bar - the real position. */
export function seekInfo(barHwnd) {
  const b = asHandle(barHwnd);
  return {
    frame: SendMessageW(b, TBM_GETPOS, 0, 0),
    first: SendMessageW(b, TBM_GETRANGEMIN, 0, 0),
    last: SendMessageW(b, TBM_GETRANGEMAX, 0, 0),
  };
}

const TBM_GETTHUMBLENGTH = 0x040c;

/**
 * Seek in place by dragging the bar, the way a person would.
 *
 * The usable track is inset by half the thumb at each end - the thumb cannot be
 * centred closer to the edge than that. Mapping frames across the full client
 * width therefore lands short near the start and the trackbar clamps to its
 * minimum, which is the replay's first frame: click near the beginning and it
 * jumps to zero.
 */
export function seekTo(barHwnd, frame) {
  const b = asHandle(barHwnd);
  const first = SendMessageW(b, TBM_GETRANGEMIN, 0, 0);
  const last = SendMessageW(b, TBM_GETRANGEMAX, 0, 0);
  const now = SendMessageW(b, TBM_GETPOS, 0, 0);
  if (last <= first) return false;
  const r = [0, 0, 0, 0];
  GetClientRect(b, r);
  const thumb = SendMessageW(b, TBM_GETTHUMBLENGTH, 0, 0) || 10;
  const half = Math.round(thumb / 2);
  const usable = Math.max(1, r[2] - thumb);
  const y = Math.max(1, Math.round(r[3] / 2));
  const at = (f) => half + Math.round(
    ((Math.min(last, Math.max(first, f)) - first) / (last - first)) * usable);
  const fromX = at(now), toX = at(frame);

  SendMessageW(b, WM_LBUTTONDOWN, 1, lparam(fromX, y));
  for (let i = 1; i <= 10; i++) {
    SendMessageW(b, WM_MOUSEMOVE, 1, lparam(Math.round(fromX + ((toX - fromX) * i) / 10), y));
  }
  SendMessageW(b, WM_LBUTTONUP, 0, lparam(toX, y));
  return true;
}
