// Clippi's local server: the UI is a plain web page, this is everything it can
// ask for. Bound to 127.0.0.1 on purpose - it can start Dolphin and upload
// files, so it is not something to expose on a network.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as lib from "./src/library.mjs";
import { motionFor } from "./src/motion.mjs";
import * as player from "./src/player.mjs";
import * as share from "./src/share.mjs";
import * as discord from "./src/discord.mjs";
import { QUALITY, previewClips, renderClip, renderDrafts, killDolphin, checkFfmpeg } from "./src/render.mjs";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "web");
const PORT = Number(process.env.CLIPPI_PORT ?? 5730);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4", ".svg": "image/svg+xml", ".png": "image/png",
};

// --- render queue ----------------------------------------------------------
// Only one Dolphin may run at a time, so renders are strictly serial. Jobs stay
// in the list after finishing so the page can show what happened.

const jobs = [];
let working = false;

function enqueue(job) {
  const entry = {
    id: `job${Date.now()}${jobs.length}`,
    status: "queued", phase: "queued", pct: 0, error: null, clipId: null,
    ...job,
  };
  jobs.push(entry);
  pump();
  return entry;
}

async function pump() {
  if (working) return;
  const job = jobs.find((j) => j.status === "queued");
  if (!job) return;
  working = true;
  job.status = "running";
  try {
    if (job.kind === "draft") {
      const made = await renderDrafts(job.clips, {
        outDir: lib.draftsDir(),
        onProgress: (p) => { job.phase = p.phase; job.pct = p.pct ?? 0; },
      });
      for (const [i, m] of made.entries()) {
        lib.saveDraft(m.key, {
          file: m.file, bytes: m.bytes, durationSec: m.durationSec,
          title: job.clips[i].label ?? "preview",
        });
      }
      lib.pruneDrafts();
      job.status = "done"; job.phase = "done"; job.pct = 1;
      return;
    }
    const cfg = lib.getConfig();
    fs.mkdirSync(cfg.outputDir, { recursive: true });
    const out = path.join(cfg.outputDir, lib.clipFileName(job.replay, job.clip));
    const res = await renderClip({
      replay: job.replay,
      startFrame: job.clip.startFrame,
      endFrame: job.clip.endFrame,
      out,
      quality: job.quality,
      onProgress: (p) => { job.phase = p.phase; job.pct = p.pct ?? 0; },
    });
    const record = lib.addClip({
      id: job.id,
      file: res.file,
      bytes: res.bytes,
      durationSec: res.durationSec,
      title: job.clip.label ?? path.basename(res.file),
      replay: job.replay,
      startFrame: job.clip.startFrame,
      endFrame: job.clip.endFrame,
      tags: job.clip.tags ?? [],
      matchup: job.matchup ?? null,
      stage: job.stage ?? null,
      quality: job.quality,
      createdAt: new Date().toISOString(),
      url: null, host: null,
    });
    job.clipId = record.id;
    job.status = "done";
    job.phase = "done";
    job.pct = 1;
  } catch (err) {
    job.status = "error";
    job.phase = "error";
    job.error = String(err?.message ?? err);
    await killDolphin().catch(() => {});
  } finally {
    working = false;
    setImmediate(pump);
  }
}

// --- best-of scan ----------------------------------------------------------
// One scan at a time. Asking for a different day selection abandons the one in
// flight rather than queueing behind it, because the user has moved on.

let best = { key: null, status: "idle", done: 0, total: 0, clips: [], error: null };

// Ranked pool held in memory; the request slices it. Generous because the Auto
// Clips tab filters this pool client-side - by tag, character, player and whose
// clip it is - and filtering only feels right if there is a deep pool to filter.
const BEST_KEEP = 4000;

function startBest(key, days) {
  const mine = { key };
  best = { key, status: "scanning", done: 0, total: 0, clips: [], error: null };
  lib.analyzeAll({
    days, limit: BEST_KEEP,
    onProgress: ({ done, total }) => {
      if (best.key !== mine.key) return;
      best.done = done;
      best.total = total;
    },
    shouldStop: () => best.key !== mine.key,
  }).then((res) => {
    if (best.key !== mine.key) return;
    best.clips = res.clips;
    best.total = res.total;
    best.done = res.scanned;
    best.status = "done";
  }).catch((err) => {
    if (best.key !== mine.key) return;
    best.status = "error";
    best.error = String(err?.message ?? err);
  });
}

// --- helpers ---------------------------------------------------------------

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "Cache-Control": "no-store", ...headers });
  res.end(body);
};
const json = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { "Content-Type": MIME[".json"] });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { return {}; }
}

/** Serve a file with Range support, which <video> needs to scrub. */
function sendFile(req, res, file, type) {
  let stat;
  try { stat = fs.statSync(file); } catch { return send(res, 404, "not found"); }
  const range = req.headers.range;
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size) {
      return send(res, 416, "", { "Content-Range": `bytes */${stat.size}` });
    }
    res.writeHead(206, {
      ...head,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, "Content-Length": stat.size });
  fs.createReadStream(file).pipe(res);
}

// --- routes ----------------------------------------------------------------

const routes = {
  "GET /api/state": async () => {
    const cfg = lib.getConfig();
    // Secrets never go back to the page. A Discord webhook url is a bearer
    // credential - anyone holding it can post into that channel - and the
    // catbox userhash is an account key. The page only needs to know whether
    // one is set, so it can say so.
    const { discordWebhook, catboxUserhash, ...safe } = cfg;
    return {
      config: safe,
      // Renders shell out to ffmpeg; without it every job dies with a bare
      // ENOENT, so the UI is told up front and can say how to fix it.
      ffmpegOk: await checkFfmpeg(),
      discordWebhookSet: !!discordWebhook,
      catboxUserhashSet: !!catboxUserhash,
      hosts: share.hostList(),
      // `draft` is the preview path, not something to render a keeper at.
      qualities: Object.entries(QUALITY)
        .filter(([, q]) => !q.draft)
        .map(([id, q]) => ({ id, label: q.label })),
      outputDir: cfg.outputDir,
    };
  },

  "GET /api/replays": async (req, url) => {
    const force = url.searchParams.get("force") === "1";
    const { dir, replays, errors } = lib.scanReplays({ force });
    const cfg = lib.getConfig();
    let perspective = cfg.perspective;
    if (!perspective && replays.length) {
      perspective = lib.guessPerspective(replays);
      if (perspective) lib.setConfig({ perspective });
    }
    return { dir, perspective, count: replays.length, replays, errors: errors.slice(0, 10) };
  },

  "GET /api/analyze": async (req, url) => {
    const file = url.searchParams.get("file");
    if (!file) throw new Error("file is required");
    const cfg = lib.getConfig();
    return lib.analyze(file, { perspective: cfg.perspective });
  },

  "POST /api/render": async (req) => {
    const body = await readBody(req);
    const cfg = lib.getConfig();
    const quality = body.quality ?? cfg.quality;
    // Best-of selections span several replays, so each clip may carry its own.
    const queued = (body.clips ?? []).map((clip) => enqueue({
      replay: clip.replay ?? body.replay,
      clip,
      quality,
      matchup: clip.matchup ?? body.matchup ?? null,
      stage: clip.stage ?? body.stage ?? null,
    }));
    return { queued: queued.map((j) => j.id) };
  },

  "GET /api/jobs": async () => ({
    jobs: jobs.slice(-40).map(({ replay, clip, clips, ...j }) => ({
      ...j,
      title: j.kind === "draft"
        ? `preview ×${clips?.length ?? 0}`
        : clip?.label ?? path.basename(replay ?? ""),
    })),
    working,
  }),

  // Draft previews: cheap 360p renders, batched into one Dolphin launch, cached
  // by clip identity so asking twice costs nothing.
  "POST /api/draft": async (req) => {
    const body = await readBody(req);
    const clips = (body.clips ?? []).map((c) => ({
      ...c,
      replay: c.replay ?? body.replay,
      key: lib.draftKey({ ...c, replay: c.replay ?? body.replay }),
    }));
    if (!clips.length) throw new Error("nothing to preview");

    const ready = {};
    const missing = [];
    for (const c of clips) {
      const hit = lib.getDraft(c.key);
      if (hit) ready[c.key] = true; else missing.push(c);
    }
    let job = null;
    if (missing.length) job = enqueue({ kind: "draft", clips: missing });
    return {
      keys: clips.map((c) => c.key),
      ready: Object.keys(ready),
      pending: missing.map((c) => c.key),
      job: job?.id ?? null,
    };
  },

  "GET /api/draft": async (req, url) => {
    const keys = (url.searchParams.get("keys") ?? "").split(",").filter(Boolean);
    const out = {};
    for (const k of keys) {
      const d = lib.getDraft(k);
      if (d) out[k] = { durationSec: d.durationSec, bytes: d.bytes };
    }
    return { drafts: out };
  },

  "POST /api/preview": async (req) => {
    const body = await readBody(req);
    const clips = (body.clips ?? []).map((c) => ({
      path: body.replay ?? c.replay, startFrame: c.startFrame, endFrame: c.endFrame,
    }));
    if (!clips.length) throw new Error("nothing to preview");
    return previewClips(clips);
  },

  // Schematic preview data. Padded either side of the clip so the in/out
  // handles can be dragged around inside what is already loaded.
  "GET /api/motion": async (req, url) => {
    const file = url.searchParams.get("file");
    if (!file) throw new Error("file is required");
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    const pad = Number(url.searchParams.get("pad") ?? 150);
    const data = motionFor(file, { start: start - pad, end: end + pad, step: 2 });
    return { ...data, clipStart: start, clipEnd: end };
  },

  // The live player: one Dolphin, kept alive, fed clips on demand.
  "GET /api/player": async () => player.status(),

  "POST /api/player/play": async (req) => {
    const body = await readBody(req);
    const clip = { ...body.clip, replay: body.clip?.replay ?? body.replay };
    // A render and the player both want Dolphin; the player yields.
    if (working) throw new Error("A render is running — wait for it to finish");
    // Deliberately NOT focusing the window here. focus() calls ShowWindow with
    // SW_RESTORE, which un-hides the very window the app has just hidden - that
    // was the white box flashing on the first play. The shell owns visibility
    // and reveals the player itself once the clip is actually running.
    return player.play(clip);
  },

  "GET /api/player/hwnd": async () => ({ hwnd: await player.hwnd() }),

  "GET /api/player/pid": async () => ({ pid: player.pid() }),

  // Bytes of audio produced so far - the app watches this to know the exact
  // moment sound starts, so the picture can be revealed at the same instant.
  "GET /api/player/audio": async () => ({ bytes: player.audioBytes() }),

  "POST /api/player/stop": async () => player.stop(),
  "POST /api/player/focus": async () => player.focus(),

  "POST /api/player/dock": async (req) => {
    const body = await readBody(req);
    return player.placeWindow(body);
  },

  "GET /api/days": async () => ({ days: lib.listDays() }),

  // Best-of scanning is slow the first time and instant after, so it runs as a
  // background job the page polls, rather than one very long request.
  "GET /api/best": async (req, url) => {
    const days = (url.searchParams.get("days") ?? "").split(",").filter(Boolean);
    const limit = Math.min(BEST_KEEP, Number(url.searchParams.get("limit") ?? 80));
    // Keyed on the day selection only. How many to show is a slice of the same
    // ranked list, so changing it must not throw away a two-minute scan.
    const key = days.slice().sort().join(",");

    if (best.key !== key) startBest(key, days);
    return {
      key, status: best.status, done: best.done, total: best.total,
      error: best.error,
      clips: best.status === "done" ? best.clips.slice(0, limit) : [],
    };
  },

  "GET /api/library": async () => ({ clips: lib.listClips() }),

  // Uploading publishes the clip to a public host. Only ever reached by an
  // explicit press of Share on one clip.
  "POST /api/share": async (req) => {
    const body = await readBody(req);
    const cfg = lib.getConfig();
    const clip = lib.listClips().find((c) => c.id === body.id);
    if (!clip) throw new Error("clip not found");
    if (clip.url && !body.again) return { url: clip.url, host: clip.host, cached: true };
    const host = body.host ?? cfg.host;
    const res = await share.upload(clip.file, {
      host,
      userhash: cfg.catboxUserhash ?? undefined,
    });
    lib.updateClip(clip.id, { url: res.url, host: res.host, sharedAt: new Date().toISOString() });
    return res;
  },

  // Posting to Discord attaches the file to a webhook message, so nothing is
  // hosted anywhere else. Only ever reached by an explicit press of Send to
  // Discord on one clip.
  "POST /api/discord": async (req) => {
    const body = await readBody(req);
    const cfg = lib.getConfig();
    const clip = lib.listClips().find((c) => c.id === body.id);
    if (!clip) throw new Error("clip not found");
    const hook = body.webhook ?? cfg.discordWebhook;
    const res = await discord.postClip(hook, clip.file, {
      content: body.content ?? clip.title ?? "",
    });
    lib.updateClip(clip.id, { postedToDiscordAt: new Date().toISOString() });
    return res;
  },

  // Put the clip on the clipboard so it can be pasted into Discord with Ctrl+V.
  // No account, no webhook, no setup - and it works in DMs and servers alike,
  // with Discord doing the upload itself.
  "POST /api/clipboard": async (req) => {
    const { id } = await readBody(req);
    const clip = lib.listClips().find((c) => c.id === id);
    if (!clip) throw new Error("clip not found");
    if (!fs.existsSync(clip.file)) throw new Error("that clip is no longer on disk");
    await execFileAsync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA",
      "-File", path.join(HERE, "shell", "clipboard.ps1"), "-Path", clip.file,
    ]);
    return { ok: true, name: path.basename(clip.file) };
  },
  // Checking a webhook before it is saved, so a bad paste is caught up front.
  "POST /api/discord/check": async (req) => {
    const { webhook } = await readBody(req);
    return discord.describeWebhook(webhook);
  },
  "POST /api/config": async (req) => lib.setConfig(await readBody(req)),

  "POST /api/delete": async (req) => {
    const body = await readBody(req);
    return { ok: lib.removeClip(body.id, { deleteFile: body.deleteFile !== false }) };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) {
    try {
      json(res, 200, await routes[key](req, url));
    } catch (err) {
      json(res, 400, { error: String(err?.message ?? err) });
    }
    return;
  }

  if (url.pathname === "/media/draft") {
    const d = lib.getDraft(url.searchParams.get("key"));
    if (!d) return send(res, 404, "no such draft");
    return sendFile(req, res, d.file, "video/mp4");
  }

  // Rendered clips, for the in-page player.
  if (url.pathname === "/media") {
    const id = url.searchParams.get("id");
    const clip = lib.listClips().find((c) => c.id === id);
    if (!clip) return send(res, 404, "no such clip");
    return sendFile(req, res, clip.file, "video/mp4");
  }

  // Static UI.
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB)) return send(res, 403, "nope");
  if (!fs.existsSync(file)) return send(res, 404, "not found");
  sendFile(req, res, file, MIME[path.extname(file)] ?? "application/octet-stream");
});

// A Dolphin from a previous run cannot be driven any more - see reconcile().
await player.reconcile();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Clippi  ->  http://localhost:${PORT}`);
  const cfg = lib.getConfig();
  console.log(`replays: ${cfg.replayDir ?? "(not found)"}`);
  console.log(`clips:   ${cfg.outputDir}`);
});

process.on("SIGINT", async () => { await killDolphin().catch(() => {}); process.exit(0); });
