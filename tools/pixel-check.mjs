// Capture the player window and report how much of it is actually drawn.
// Used to prove the layered-window trick does not break Dolphin's rendering:
// a black or empty frame here means the ghosting cost us the picture.
import fs from "node:fs";
import { createRequire } from "node:module";
const koffi = createRequire(import.meta.url)("koffi");
const u = koffi.load("user32.dll");
const g = koffi.load("gdi32.dll");
const H = koffi.pointer("HPX", koffi.opaque());
const Cb = koffi.proto("bool __stdcall CbPX(HPX h, intptr p)");
const EnumWindows = u.func("bool __stdcall EnumWindows(CbPX* cb, intptr l)");
const GetWindowTextW = u.func("int __stdcall GetWindowTextW(HPX h, _Out_ uint16_t *b, int n)");
const GetWindowRect = u.func("bool __stdcall GetWindowRect(HPX h, _Out_ int32 *r)");
const GetWindowDC = u.func("HPX __stdcall GetWindowDC(HPX h)");
const ReleaseDC = u.func("int __stdcall ReleaseDC(HPX h, HPX dc)");
const PrintWindow = u.func("bool __stdcall PrintWindow(HPX h, HPX dc, uint32 flags)");
const CreateCompatibleDC = g.func("HPX __stdcall CreateCompatibleDC(HPX dc)");
const CreateCompatibleBitmap = g.func("HPX __stdcall CreateCompatibleBitmap(HPX dc, int w, int h)");
const SelectObject = g.func("HPX __stdcall SelectObject(HPX dc, HPX o)");
const DeleteObject = g.func("bool __stdcall DeleteObject(HPX o)");
const DeleteDC = g.func("bool __stdcall DeleteDC(HPX dc)");
const GetDIBits = g.func("int __stdcall GetDIBits(HPX dc, HPX bmp, uint32 start, uint32 lines, _Out_ uint8_t *bits, void *bi, uint32 usage)");

const OUT = "C:/root/WOMBO/px.txt";
fs.writeFileSync(OUT, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let addr = null;
const cb = koffi.register((h) => {
  const b = new Uint16Array(256);
  const n = GetWindowTextW(h, b, 256);
  if (n && Buffer.from(b.buffer, 0, n * 2).toString("utf16le").includes("Faster Melee")) {
    addr = koffi.address(h); return false;
  }
  return true;
}, koffi.pointer(Cb));

function sample() {
  addr = null;
  EnumWindows(cb, 0);
  if (!addr) return "no Dolphin window";
  const hwnd = koffi.as(BigInt(addr), "HPX");
  const r = [0, 0, 0, 0];
  GetWindowRect(hwnd, r);
  const w = r[2] - r[0], h = r[3] - r[1];
  if (w < 2 || h < 2) return `window is ${w}x${h}`;
  const winDC = GetWindowDC(hwnd);
  const memDC = CreateCompatibleDC(winDC);
  const bmp = CreateCompatibleBitmap(winDC, w, h);
  SelectObject(memDC, bmp);
  const ok = PrintWindow(hwnd, memDC, 2);          // PW_RENDERFULLCONTENT
  const bi = Buffer.alloc(40);
  bi.writeUInt32LE(40, 0); bi.writeInt32LE(w, 4); bi.writeInt32LE(-h, 8);
  bi.writeUInt16LE(1, 12); bi.writeUInt16LE(32, 14);
  const bits = Buffer.alloc(w * h * 4);
  const lines = GetDIBits(memDC, bmp, 0, h, bits, bi, 0);
  const hist = new Map();
  for (let i = 0; i < w * h; i += 7) {
    const px = bits.readUInt32LE(i * 4) & 0xffffff;
    hist.set(px, (hist.get(px) || 0) + 1);
  }
  const samples = Math.ceil((w * h) / 7);
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  DeleteObject(bmp); DeleteDC(memDC); ReleaseDC(hwnd, winDC);
  // How much of the window is Dolphin's own grey panel rather than gameplay?
  // Dolphin paints its chrome in these two greys; either one showing means a
  // band of window background is visible instead of gameplay.
  const grey = ((hist.get(0xf0f0f0) || 0) + (hist.get(0xdcdcdc) || 0)) / samples;
  return `${w}x${h} pw=${ok} lines=${lines} colours=${hist.size} `
    + `chromeGrey=${(100 * grey).toFixed(1)}% top=`
    + top.map(([c, n]) => `#${c.toString(16).padStart(6, "0")}:${(100 * n / samples).toFixed(0)}%`).join(",");
}

const t0 = Date.now();
while (Date.now() - t0 < 75000) {
  fs.appendFileSync(OUT, String(Date.now() - t0).padStart(6) + "ms  " + sample() + String.fromCharCode(10));
  await sleep(2000);
}
