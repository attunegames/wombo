// Putting a finished clip somewhere other people can watch it.
//
// Uploading is publishing: every host here hands back a public URL that anyone
// who has it can open. Nothing in this file runs on its own - the server only
// calls it when the user presses Share on a specific clip.
//
// catbox.moe is the default because it needs no account and returns a direct
// .mp4 link, which is the one thing that makes a clip play inline in Discord
// instead of becoming a link people have to click. The adapter shape is here so
// an S3/R2 bucket or a Streamable account can be added without touching the
// server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Check the host actually stored what we sent.
 *
 * catbox returned a perfectly good URL for a file it saved as ZERO bytes - the
 * link worked, the video was empty, and nothing in the response said so. The
 * bytes reached catbox (measured: the full body goes on the wire from both
 * plain node and Electron's), so the only way to know is to ask for it back.
 *
 * Newly uploaded files can take a moment to be served, so a miss is retried
 * before it is believed.
 */
async function verifyUpload(url, expectedBytes, { attempts = 4, signal } = {}) {
  let seen = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 800 * i));
    try {
      // A ONE BYTE ranged GET, not HEAD: catbox answers HEAD with
      // "content-length: 0" for good and empty files alike, so HEAD cannot tell
      // them apart. A range request answers 206 with "content-range:
      // bytes 0-0/<total>" for a real file, and plain 200 with no body for the
      // empty one.
      const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });
      const range = res.headers.get("content-range");
      const total = range ? Number(range.split("/")[1]) : null;
      const got = (await res.arrayBuffer()).byteLength;
      if (Number.isFinite(total) && total > 0) {
        seen = total;
        // Hosts may re-encode, so this is a sanity check for a FAILED upload,
        // not a demand for an exact byte match.
        if (total > expectedBytes * 0.5) return { ok: true, bytes: total };
      } else if (got > 0) {
        return { ok: true, bytes: null };   // serving content, size not stated
      } else {
        seen = 0;
      }
    } catch { /* not served yet */ }
  }
  return { ok: false, bytes: seen };
}

/**
 * A byte-different copy of the same video, for when the host has cached a
 * failure against this exact file.
 *
 * catbox DEDUPLICATES BY CONTENT: once it has stored a file as empty, uploading
 * those identical bytes hands back the same broken URL forever - re-sharing can
 * never fix it. Stream-copying through ffmpeg with a fresh comment changes the
 * hash without touching a single frame, so the retry lands on a new entry.
 */
async function nudgedCopy(file) {
  const out = path.join(os.tmpdir(), `wombo-reshare-${Date.now()}.mp4`);
  await execFileAsync("ffmpeg", [
    "-v", "error", "-y", "-i", file,
    "-c", "copy",                       // no re-encode: same video, new bytes
    "-metadata", `comment=wombo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    "-movflags", "+faststart", out,
  ]);
  return out;
}

async function postToCatbox(file, userhash, signal) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  if (userhash) form.append("userhash", userhash);
  form.append("fileToUpload", await fs.openAsBlob(file), path.basename(file));

  const res = await fetch("https://catbox.moe/user/api.php", {
    method: "POST",
    body: form,
    signal,
    headers: { "User-Agent": "Wombo/0.1 (Slippi clip tool)" },
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`catbox refused the upload (${res.status}): ${text.slice(0, 200)}`);
  // An empty 200 is catbox's way of failing without saying so - seen while it
  // was refusing every upload, including a 2KB test file. Worth naming, because
  // "catbox returned: " tells you nothing about whose fault it is.
  if (!text) {
    throw new Error("catbox accepted the upload but returned nothing, which means it is refusing uploads right now. Your clip is fine and still on disk - try again later.");
  }
  if (!/^https?:\/\//.test(text)) throw new Error(`catbox returned: ${text.slice(0, 200)}`);
  return text;
}

export const HOSTS = {};

const MB = 1024 * 1024;

/**
 * catbox.moe - anonymous, permanent, 200MB per file.
 * A userhash (from a free catbox account) is optional; supplying one files the
 * upload under that account so it can be deleted later.
 */
HOSTS.catbox = {
  id: "catbox",
  name: "catbox.moe",
  limitBytes: 200 * MB,
  note: "Anonymous and permanent. Anyone with the link can watch it.",
  async upload(file, { userhash = null, signal } = {}) {
    const bytes = fs.statSync(file).size;
    if (bytes > this.limitBytes) {
      throw new Error(`Clip is ${(bytes / MB).toFixed(1)}MB; catbox allows 200MB. Render it smaller.`);
    }
    const text = await postToCatbox(file, userhash, signal);

    const check = await verifyUpload(text, bytes, { signal });
    if (check.ok) return { url: text, host: "catbox", bytes };

    // Retry ONCE with different bytes. Uploading the same file again is
    // pointless - catbox dedupes by content and would hand back this very URL.
    let copy = null;
    try {
      copy = await nudgedCopy(file);
      const retry = await postToCatbox(copy, userhash, signal);
      const second = await verifyUpload(retry, bytes, { signal });
      if (second.ok) return { url: retry, host: "catbox", bytes };
      throw new Error(`catbox stored the clip as an empty file twice (${retry}). The clip itself is fine - try again in a minute, or switch host to litterbox.`);
    } finally {
      if (copy) fs.rmSync(copy, { force: true });
    }
  },
  async remove(url, { userhash }) {
    if (!userhash) throw new Error("Deleting from catbox needs the userhash from your catbox account.");
    const form = new FormData();
    form.append("reqtype", "deletefiles");
    form.append("userhash", userhash);
    form.append("files", path.basename(new URL(url).pathname));
    const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
    return (await res.text()).trim();
  },
};

/**
 * litterbox.catbox.moe - same API, but the file expires. Useful for a clip you
 * only need to show somebody once.
 */
HOSTS.litterbox = {
  id: "litterbox",
  name: "litterbox (temporary)",
  limitBytes: 1024 * MB,
  note: "Expires automatically. Nothing to clean up.",
  async upload(file, { expiry = "72h", signal } = {}) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", expiry);           // 1h, 12h, 24h, 72h
    form.append("fileToUpload", await fs.openAsBlob(file), path.basename(file));
    const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
      method: "POST", body: form, signal,
      headers: { "User-Agent": "Wombo/0.1 (Slippi clip tool)" },
    });
    const text = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//.test(text)) {
      throw new Error(`litterbox returned: ${text.slice(0, 200)}`);
    }
    const bytes = fs.statSync(file).size;
    const check = await verifyUpload(text, bytes, { signal });
    if (!check.ok) {
      throw new Error(`litterbox stored ${check.bytes ?? "an unknown number of"} bytes of a ${bytes}-byte clip (${text}). Try sharing it again.`);
    }
    return { url: text, host: "litterbox", bytes };
  },
};

/**
 * uguu.se - anonymous, but the file is deleted after a few hours.
 *
 * Here because it is the only anonymous host measured working correctly:
 * a direct .mp4 URL served as video/mp4 with the right byte count, which is
 * what Discord needs to embed a player rather than print a link. catbox is the
 * one to use when it is healthy, since these expire.
 */
HOSTS.uguu = {
  id: "uguu",
  name: "uguu.se (expires in hours)",
  limitBytes: 128 * MB,
  note: "No account, embeds in Discord, but the file is deleted after a few hours.",
  async upload(file, { signal } = {}) {
    const bytes = fs.statSync(file).size;
    if (bytes > this.limitBytes) {
      throw new Error(`Clip is ${(bytes / MB).toFixed(1)}MB; uguu allows 128MB. Render it smaller.`);
    }
    const form = new FormData();
    form.append("files[]", await fs.openAsBlob(file), path.basename(file));
    const res = await fetch("https://uguu.se/upload?output=text", {
      method: "POST", body: form, signal,
      headers: { "User-Agent": "Wombo/0.1 (Slippi clip tool)" },
    });
    const text = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//.test(text)) {
      throw new Error(`uguu returned: ${text.slice(0, 200) || "(nothing)"}`);
    }
    const check = await verifyUpload(text, bytes, { signal });
    if (!check.ok) throw new Error(`uguu stored an empty file (${text}). Try again.`);
    return { url: text, host: "uguu", bytes };
  },
};

export function hostList() {
  return Object.values(HOSTS).map(({ id, name, limitBytes, note }) =>
    ({ id, name, limitMB: Math.round(limitBytes / MB), note }));
}

export async function upload(file, { host = "catbox", ...opts } = {}) {
  const h = HOSTS[host];
  if (!h) throw new Error(`Unknown clip host "${host}"`);
  return h.upload(file, opts);
}
