// pomf-style clones: POST files[] to /upload.php, get a direct link back.
// Looking for one that is PERMANENT, needs no account, and serves video/mp4.
import fs from "node:fs";
const buf = fs.readFileSync(process.argv[2]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const endpoints = [
  ["pomf.lain.la", "https://pomf.lain.la/upload.php"],
  ["qu.ax",        "https://qu.ax/upload.php"],
  ["kappa.lol",    "https://kappa.lol/api/upload"],
  ["nyaa.si-pomf", "https://pomf2.lain.la/upload.php"],
];

for (const [name, url] of endpoints) {
  let out = "";
  try {
    const f = new FormData();
    f.append("files[]", new Blob([buf], { type: "video/mp4" }), "clip.mp4");
    const r = await fetch(url, { method: "POST", body: f, headers: { "User-Agent": UA } });
    const t = await r.text();
    let link = "";
    try {
      const j = JSON.parse(t);
      link = j?.files?.[0]?.url ?? j?.url ?? j?.link ?? "";
    } catch { link = t.trim(); }
    out = link;
    if (!/^https?:\/\//.test(out)) { console.log(`${name.padEnd(14)} FAILED ${t.slice(0, 100).replace(/\s+/g, " ")}`); continue; }
  } catch (e) { console.log(`${name.padEnd(14)} threw ${e.message}`); continue; }

  try {
    const res = await fetch(out, { headers: { Range: "bytes=0-0", "User-Agent": UA } });
    const range = res.headers.get("content-range");
    const total = range ? Number(range.split("/")[1]) : null;
    const got = (await res.arrayBuffer()).byteLength;
    console.log(`${name.padEnd(14)} ${String(res.status).padEnd(4)} type=${String(res.headers.get("content-type")).padEnd(16)} bytes=${total ?? got}  ${out}`);
  } catch (e) { console.log(`${name.padEnd(14)} uploaded, fetch-back failed: ${e.message} ${out}`); }
}
