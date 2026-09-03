// Is Dolphin's window ever visible on first launch, with nothing managing it?
// Results go to a file: piped stdout has been getting lost.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as d from "../src/dolphin.mjs";

const koffi = createRequire(import.meta.url)("koffi");
const u = koffi.load("user32.dll");
const H = koffi.pointer("HP1", koffi.opaque());
const Cb = koffi.proto("bool __stdcall CbP(HP1 h, intptr p)");
const EnumWindows = u.func("bool __stdcall EnumWindows(CbP* cb, intptr l)");
const GetWindowTextW = u.func("int __stdcall GetWindowTextW(HP1 h, _Out_ uint16_t *b, int n)");
const GetWindowRect = u.func("bool __stdcall GetWindowRect(HP1 h, _Out_ int32 *r)");
const IsWindowVisible = u.func("bool __stdcall IsWindowVisible(HP1 h)");

const OUT = "C:/root/CLIPPI/flash-probe.json";
// Pass a .slp path as the first argument.
const REPLAY = process.argv[2];
if (!REPLAY) { console.error("usage: node tools/flash-probe.mjs <replay.slp>"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execFileSync("taskkill", ["/F", "/IM", "Slippi Dolphin.exe"], { stdio: "ignore" }); } catch {}
await sleep(1200);

function probe() {
  let hit = null;
  const cb = koffi.register((h) => {
    const b = new Uint16Array(256);
    const n = GetWindowTextW(h, b, 256);
    if (n && Buffer.from(b.buffer, 0, n * 2).toString("utf16le").includes("Faster Melee")) {
      const r = [0, 0, 0, 0];
      GetWindowRect(h, r);
      hit = { rect: r.join(","), visible: !!IsWindowVisible(h) };
      return false;
    }
    return true;
  }, koffi.pointer(Cb));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return hit;
}

const { isoPath } = d.ensureSandbox();
d.writeRenderConfigs({ dump: false, internalRes: 2, speed: 1, chrome: false, audioProbe: true });
const q = d.writeQueue([{ path: REPLAY, startFrame: 500, endFrame: 8652 }]);

const t0 = Date.now();
d.runQueue(q, { isoPath, hidden: true }).catch(() => {});

const log = [];
let everVisible = false;
let lastKey = null;
for (let i = 0; i < 5000 && Date.now() - t0 < 25000; i++) {
  const p = probe();
  if (p) {
    if (p.visible) everVisible = true;
    const key = `${p.visible}|${p.rect}`;
    if (key !== lastKey) { log.push({ at: Date.now() - t0, ...p }); lastKey = key; }
  }
  await sleep(5);
}

fs.writeFileSync(OUT, JSON.stringify({
  everVisibleWithNobodyManagingIt: everVisible,
  windowAppearedAt: log[0]?.at ?? null,
  states: log.slice(0, 12),
}, null, 2));
try { execFileSync("taskkill", ["/F", "/IM", "Slippi Dolphin.exe"], { stdio: "ignore" }); } catch {}
