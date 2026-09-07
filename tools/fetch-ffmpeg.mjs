// Fetch the ffmpeg that ships with a release.
//
// Runs automatically before `npm run package`. The binary is NOT in git - it is
// ~98MB and would bloat every clone - so it is downloaded once into vendor/ and
// reused after that.
//
// The build is gyan.dev's "essentials", which is GPL v3 and carries libx264 and
// aac, the two encoders a render actually needs. Wombo is GPL-3.0 too, so
// redistributing it is fine as long as the licence travels with it - hence
// vendor/FFMPEG-LICENSE.txt and the note in the README.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "vendor");
const EXE = path.join(VENDOR, "ffmpeg.exe");
const URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

if (fs.existsSync(EXE)) {
  const mb = (fs.statSync(EXE).size / 1048576).toFixed(0);
  console.log(`ffmpeg already vendored (${mb}MB) - delete vendor/ffmpeg.exe to refresh`);
  process.exit(0);
}

fs.mkdirSync(VENDOR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(VENDOR, "dl-"));
const zip = path.join(tmp, "ffmpeg.zip");

try {
  console.log(`downloading ${URL}`);
  console.log("(~106MB, once - it is cached in vendor/ afterwards)");
  execFileSync("curl.exe", ["-sL", "--fail", "--max-time", "900", "-o", zip, URL], { stdio: "inherit" });

  // bsdtar ships with Windows and reads zip; Expand-Archive is far slower.
  execFileSync("tar.exe", ["-xf", zip], { cwd: tmp, stdio: "inherit" });

  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "ffmpeg.exe" || /^LICENSE/i.test(e.name)) found.push(full);
    }
  };
  walk(tmp);

  const exe = found.find((f) => f.endsWith("ffmpeg.exe"));
  if (!exe) throw new Error("no ffmpeg.exe inside the archive");
  fs.copyFileSync(exe, EXE);

  const lic = found.find((f) => /LICENSE/i.test(path.basename(f)));
  if (lic) fs.copyFileSync(lic, path.join(VENDOR, "FFMPEG-LICENSE.txt"));

  const version = execFileSync(EXE, ["-version"], { encoding: "utf8" }).split("\n")[0];
  console.log(`vendored: ${version}`);
  console.log(`${(fs.statSync(EXE).size / 1048576).toFixed(0)}MB -> ${EXE}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
