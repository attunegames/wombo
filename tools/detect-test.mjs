import { findClips } from "../src/detect.mjs";
import fs from "node:fs"; import path from "node:path";
// Pass a folder of .slp files as the first argument.
const dir = process.argv[2];
if (!dir) { console.error("usage: node tools/detect-test.mjs <folder-of-slp>"); process.exit(1); }
const files = fs.readdirSync(dir).filter(f=>f.endsWith(".slp")).slice(0, Number(process.argv[2]||3));
for (const f of files) {
  const r = findClips(path.join(dir,f), { perspective: "BIRD#704" });
  console.log(`\n=== ${f}  ${r.matchup} on ${r.stage}  (${r.durationSec}s)`);
  for (const c of r.clips.slice(0,6))
    console.log(`  ${String(c.score).padStart(3)} ${c.yours?"*":" "} ${c.label.padEnd(38)} f${c.startFrame}-${c.endFrame} ${c.durationSec}s [${c.tags.join(",")}] ${c.moves.join(">")}`);
}
