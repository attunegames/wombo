import * as d from "../src/dolphin.mjs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

// Pass a .slp path as the first argument.
const REPLAY = process.argv[2];
if (!REPLAY) { console.error("usage: node tools/audio-test.mjs <replay.slp>"); process.exit(1); }
const variants = [
  { name: "baseline (speakers on)",       cfg: {} },
  { name: "DSP Volume=0",                 cfg: { volume: 0 } },
  { name: "DSP Volume=0 + jukebox muted", cfg: { volume: 0, jukeboxVolume: 0 } },
  { name: "jukebox disabled entirely",    cfg: { volume: 0, jukebox: false } },
];

const { isoPath } = d.ensureSandbox();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const kill = () => { try { execFileSync("taskkill",["/F","/IM","Slippi Dolphin.exe"],{stdio:"ignore"}); } catch {} };
const loudness = (f) => {
  try {
    execFileSync("ffmpeg", ["-hide_banner","-i",f,"-af","volumedetect","-f","null","-"],
      { windowsHide: true, stdio: ["ignore","ignore","pipe"] });
    return "?";
  } catch (e) {
    const s = String(e.stderr ?? "");
    return (s.match(/mean_volume: ([-\d.]+) dB/) || [])[1] ?? "?";
  }
};

for (const v of variants) {
  kill(); await sleep(500);
  d.writeRenderConfigs({ dump: true, internalRes: 1, ...v.cfg });
  d.clearDump();
  const q = d.writeQueue([{ path: REPLAY, startFrame: 600, endFrame: 780 }]);
  const p = d.dumpPaths();
  const wav = p.audio + "/dspdump.wav";
  d.runQueue(q, { isoPath, hidden: true }).catch(()=>{});
  const target = 3 * 32000 * 4;
  for (let i = 0; i < 150; i++) {
    await sleep(400);
    let s = 0; try { s = fs.statSync(wav).size; } catch {}
    if (s >= target * 0.99) break;
  }
  await sleep(600); kill(); await sleep(500);
  let size = 0, md5 = "-", mean = "-";
  try {
    const buf = fs.readFileSync(wav);
    size = buf.length;
    md5 = crypto.createHash("md5").update(buf).digest("hex").slice(0, 10);
    mean = loudness(wav);
  } catch {}
  console.log(`${v.name.padEnd(30)} size=${size} md5=${md5} mean=${mean}dB`);
}
kill();
