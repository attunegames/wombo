// Does the upload actually put the file's bytes on the wire?
//
// A 17MB clip uploaded to catbox as a 0-byte file while an 8MB one worked, so
// this posts the SAME multipart body to a local sink and counts what arrives -
// no publishing involved.
import http from "node:http";
import fs from "node:fs";

const file = process.argv[2];
const size = fs.statSync(file).size;

let received = 0;
const server = http.createServer((req, res) => {
  req.on("data", (c) => { received += c.length; });
  req.on("end", () => { res.writeHead(200); res.end("https://example.invalid/ok.mp4"); });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const form = new FormData();
form.append("reqtype", "fileupload");
form.append("fileToUpload", await fs.openAsBlob(file), "clip.mp4");

const started = Date.now();
let err = null;
try {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: form,
    headers: { "User-Agent": "Wombo/0.1 (Slippi clip tool)" },
  });
  await res.text();
} catch (e) { err = e; }

console.log(JSON.stringify({
  node: process.versions.node,
  electronNode: !!process.env.ELECTRON_RUN_AS_NODE,
  fileBytes: size,
  bodyBytesReceived: received,
  // Multipart adds headers and boundaries, so a healthy body is a little larger.
  ratio: (received / size).toFixed(4),
  tookMs: Date.now() - started,
  error: err ? String(err.message ?? err) : null,
}, null, 2));
server.close();
