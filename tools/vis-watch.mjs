// Log every visibility/rect transition of Dolphin's window during a real app
// session, so a flash can be pinned to the exact millisecond and rect.
import fs from "node:fs";
import { createRequire } from "node:module";
const koffi = createRequire(import.meta.url)("koffi");
const u = koffi.load("user32.dll");
koffi.pointer("HP1", koffi.opaque());
const Cb = koffi.proto("bool __stdcall CbP(HP1 h, intptr p)");
const EnumWindows = u.func("bool __stdcall EnumWindows(CbP* cb, intptr l)");
const GetWindowTextW = u.func("int __stdcall GetWindowTextW(HP1 h, _Out_ uint16_t *b, int n)");
const GetWindowRect = u.func("bool __stdcall GetWindowRect(HP1 h, _Out_ int32 *r)");
const IsWindowVisible = u.func("bool __stdcall IsWindowVisible(HP1 h)");
const OUT = fs.createWriteStream("C:/root/CLIPPI/vis-watch.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let found = null;
const enumCb = koffi.register((h) => {
  const b = new Uint16Array(256);
  const n = GetWindowTextW(h, b, 256);
  if (n && Buffer.from(b.buffer, 0, n * 2).toString("utf16le").includes("Faster Melee")) {
    found = koffi.address(h);   // keep the address: the pointer is only valid inside the callback
    return false;
  }
  return true;
}, koffi.pointer(Cb));

// Registered once: re-registering per sample made each probe cost far more than
// the poll interval, which flatters any flash it is trying to measure.
let known = null;
function probe() {
  if (!known) { found = null; EnumWindows(enumCb, 0); known = found ? koffi.as(BigInt(found), 'HP1') : null; }
  if (!known) return null;
  const r = [0, 0, 0, 0];
  if (!GetWindowRect(known, r)) { known = null; return null; }
  return {
    v: !!IsWindowVisible(known),
    r: `${r[0]},${r[1]} ${r[2] - r[0]}x${r[3] - r[1]}`,
    h: String(koffi.address(known)),
  };
}

const t0 = Date.now(); let last = null;
while (Date.now() - t0 < 120000) {
  const p = probe();
  const key = p ? `${p.v}|${p.r}|${p.h}` : "gone";
  if (key !== last) { OUT.write(`${String(Date.now() - t0).padStart(6)}ms  ${p ? (p.v ? "VISIBLE" : "hidden ") + "  " + p.r + "  hwnd=" + p.h : "(no window)"}\n`); last = key; }
  await sleep(1);
}
OUT.end();
