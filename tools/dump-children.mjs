// Print Dolphin's child-window tree: class, rect, visibility. Run while the
// player is up to see exactly what the strip under the gameplay is made of.
import { createRequire } from "node:module";
const koffi = createRequire(import.meta.url)("koffi");
const u = koffi.load("user32.dll");
koffi.pointer("HP1", koffi.opaque());
const Cb = koffi.proto("bool __stdcall CbP(HP1 h, intptr p)");
const EnumWindows = u.func("bool __stdcall EnumWindows(CbP* cb, intptr l)");
const EnumChildWindows = u.func("bool __stdcall EnumChildWindows(HP1 p, CbP* cb, intptr l)");
const GetWindowTextW = u.func("int __stdcall GetWindowTextW(HP1 h, _Out_ uint16_t *b, int n)");
const GetClassNameW = u.func("int __stdcall GetClassNameW(HP1 h, _Out_ uint16_t *b, int n)");
const GetWindowRect = u.func("bool __stdcall GetWindowRect(HP1 h, _Out_ int32 *r)");
const IsWindowVisible = u.func("bool __stdcall IsWindowVisible(HP1 h)");
const GetParent = u.func("HP1 __stdcall GetParent(HP1 h)");

const txt = (fn, h) => { const b = new Uint16Array(256); const n = fn(h, b, 256);
  return n ? Buffer.from(b.buffer, 0, n * 2).toString("utf16le") : ""; };

let top = null;
let cb = koffi.register((h) => {
  if (txt(GetWindowTextW, h).includes("Faster Melee")) { top = h; return false; }
  return true;
}, koffi.pointer(Cb));
EnumWindows(cb, 0); koffi.unregister(cb);
if (!top) { console.log("no Dolphin window"); process.exit(0); }

const R = (h) => { const r = [0, 0, 0, 0]; GetWindowRect(h, r);
  return { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] }; };
const tr = R(top);
console.log(`TOP  hwnd=${koffi.address(top)} "${txt(GetWindowTextW, top).slice(0, 60)}" ${tr.x},${tr.y} ${tr.w}x${tr.h} visible=${!!IsWindowVisible(top)}`);

const rows = [];
cb = koffi.register((h) => {
  const r = R(h);
  rows.push({
    hwnd: String(koffi.address(h)),
    parent: String(koffi.address(GetParent(h)) || 0),
    cls: txt(GetClassNameW, h),
    text: txt(GetWindowTextW, h).slice(0, 55),
    rel: `${r.x - tr.x},${r.y - tr.y}`,
    size: `${r.w}x${r.h}`,
    vis: !!IsWindowVisible(h),
  });
  return true;
}, koffi.pointer(Cb));
EnumChildWindows(top, cb, 0); koffi.unregister(cb);

console.log(`\n${rows.length} child windows (rel = offset from the top window):\n`);
for (const r of rows) {
  console.log(`${r.vis ? "VIS " : "hid "} ${r.cls.padEnd(22)} ${r.rel.padEnd(12)} ${r.size.padEnd(11)} parent=${r.parent === String(koffi.address(top)) ? "TOP" : r.parent}  "${r.text}"`);
}
