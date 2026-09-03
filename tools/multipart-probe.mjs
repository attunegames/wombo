// What does our upload actually send? Posts the same FormData to a local sink
// and reports the multipart part headers, so a rejected upload can be traced
// without publishing anything.
import http from "node:http";
import fs from "node:fs";

const file = process.argv[2];
let raw = Buffer.alloc(0);
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    raw = Buffer.concat(chunks);
    console.log("content-type:", req.headers["content-type"]);
    console.log("content-length header:", req.headers["content-length"] ?? "(none, chunked)");
    console.log("body bytes:", raw.length);
    // Print just the part headers, not the binary payload.
    const text = raw.subarray(0, Math.min(raw.length, 4000)).toString("latin1");
    for (const line of text.split("\r\n")) {
      if (line.startsWith("--") || line.toLowerCase().startsWith("content-")) console.log("  |", line);
    }
    res.writeHead(200); res.end("https://example.invalid/ok.mp4");
    server.close();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const form = new FormData();
form.append("reqtype", "fileupload");
form.append("time", "1h");
form.append("fileToUpload", await fs.openAsBlob(file), "clip.mp4");
const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
  method: "POST", body: form,
  headers: { "User-Agent": "Clippi/0.1 (Slippi clip tool)" },
});
await res.text();
