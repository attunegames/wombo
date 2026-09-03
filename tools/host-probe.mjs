// Which anonymous file hosts actually work right now, and would Discord embed
// the result? Discord needs a DIRECT url that serves video/mp4 - a landing page
// or a download-gate link will not embed.
import fs from "node:fs";

const file = process.argv[2];
const buf = fs.readFileSync(file);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const hosts = [
  {
    name: "0x0.st",
    async up() {
      const f = new FormData();
      f.append("file", new Blob([buf], { type: "video/mp4" }), "clip.mp4");
      const r = await fetch("https://0x0.st", { method: "POST", body: f, headers: { "User-Agent": UA } });
      return (await r.text()).trim();
    },
  },
  {
    name: "tmpfiles.org",
    async up() {
      const f = new FormData();
      f.append("file", new Blob([buf], { type: "video/mp4" }), "clip.mp4");
      const r = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: f, headers: { "User-Agent": UA } });
      const j = await r.json().catch(() => null);
      const u = j?.data?.url ?? "";
      // tmpfiles gives a landing page; /dl/ is the direct one.
      return u ? u.replace("tmpfiles.org/", "tmpfiles.org/dl/") : JSON.stringify(j).slice(0, 120);
    },
  },
  {
    name: "uguu.se",
    async up() {
      const f = new FormData();
      f.append("files[]", new Blob([buf], { type: "video/mp4" }), "clip.mp4");
      const r = await fetch("https://uguu.se/upload?output=text", { method: "POST", body: f, headers: { "User-Agent": UA } });
      return (await r.text()).trim();
    },
  },
  {
    name: "catbox.moe",
    async up() {
      const f = new FormData();
      f.append("reqtype", "fileupload");
      f.append("fileToUpload", new Blob([buf], { type: "video/mp4" }), "clip.mp4");
      const r = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: f, headers: { "User-Agent": UA } });
      return (await r.text()).trim();
    },
  },
];

for (const h of hosts) {
  let url = "", note = "";
  try { url = await h.up(); } catch (e) { note = "upload threw: " + e.message; }
  if (!/^https?:\/\//.test(url)) {
    console.log(`${h.name.padEnd(14)} FAILED  ${note || JSON.stringify(url).slice(0, 90)}`);
    continue;
  }
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0", "User-Agent": UA } });
    const range = res.headers.get("content-range");
    const total = range ? Number(range.split("/")[1]) : null;
    const got = (await res.arrayBuffer()).byteLength;
    console.log(`${h.name.padEnd(14)} ${String(res.status).padEnd(4)} type=${String(res.headers.get("content-type")).padEnd(16)} bytes=${total ?? got} mp4Url=${url.endsWith(".mp4")}  ${url}`);
  } catch (e) {
    console.log(`${h.name.padEnd(14)} uploaded but could not fetch back: ${e.message}  ${url}`);
  }
}
