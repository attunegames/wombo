// The two things Wombo remembers: what replays exist, and what clips we made.
//
// Parsing a .slp costs real time (getStats walks every frame), and the replay
// folder here has hundreds of files, so both the per-file header and the
// detected clips are cached against the file's size+mtime. Change the file and
// the cache entry stops matching; it never goes stale silently.

import fs from "node:fs";
import path from "node:path";

import { WOMBO_DATA, replayDir } from "./dolphin.mjs";
import { analyzeRaw, findClips, rankFor, readHeader } from "./detect.mjs";

const INDEX_FILE = path.join(WOMBO_DATA, "index.json");
const CLIPCACHE_FILE = path.join(WOMBO_DATA, "clipcache.json");
const CLIPS_FILE = path.join(WOMBO_DATA, "clips.json");
const CONFIG_FILE = path.join(WOMBO_DATA, "config.json");

const DEFAULT_CONFIG = {
  replayDir: null,          // null = ask Slippi
  outputDir: path.join(process.env.USERPROFILE ?? WOMBO_DATA, "Videos", "Wombo"),
  perspective: null,        // your connect code, e.g. "BIRD#704"
  quality: "good",
  host: "catbox",
  catboxUserhash: null,
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function getConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  if (!cfg.replayDir) cfg.replayDir = replayDir();
  return cfg;
}
export function setConfig(patch) {
  const next = { ...readJson(CONFIG_FILE, {}), ...patch };
  writeJson(CONFIG_FILE, next);
  return getConfig();
}

/** Your own connect code, guessed from whichever code appears in most replays. */
export function guessPerspective(replays) {
  const seen = new Map();
  for (const r of replays) {
    for (const p of r.players) {
      if (!p.code) continue;
      seen.set(p.code, (seen.get(p.code) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [code, n] of seen) if (!best || n > best.n) best = { code, n };
  // Only claim it if that code is in most of the games - otherwise this is a
  // shared PC or a folder of downloaded replays and guessing would be wrong.
  return best && best.n >= replays.length * 0.6 ? best.code : null;
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith(".slp")) out.push(p);
  }
  return out;
}

const stamp = (file) => {
  const s = fs.statSync(file);
  return `${s.size}:${Math.round(s.mtimeMs)}`;
};

/**
 * List every replay, newest first. Headers are parsed lazily and cached, so the
 * first scan of a big folder is slow and every one after it is instant.
 */
export function scanReplays({ force = false, onProgress } = {}) {
  const cfg = getConfig();
  if (!cfg.replayDir) return { dir: null, replays: [], errors: ["No Slippi replay folder found."] };

  const cache = force ? {} : readJson(INDEX_FILE, {});
  const files = walk(cfg.replayDir);
  const replays = [];
  const errors = [];
  let parsed = 0;

  for (const [i, file] of files.entries()) {
    let key;
    try { key = stamp(file); } catch { continue; }
    const hit = cache[file];
    if (hit?.key === key) { replays.push(hit.header); continue; }
    try {
      const header = readHeader(file);
      cache[file] = { key, header };
      replays.push(header);
      parsed++;
    } catch (err) {
      cache[file] = { key, header: null, error: String(err.message) };
      errors.push(`${path.basename(file)}: ${err.message}`);
    }
    onProgress?.({ done: i + 1, total: files.length, parsed });
  }

  for (const k of Object.keys(cache)) if (!fs.existsSync(k)) delete cache[k];
  writeJson(INDEX_FILE, cache);

  replays.sort((a, b) => String(b.startAt ?? "").localeCompare(String(a.startAt ?? "")));
  return { dir: cfg.replayDir, replays, errors };
}

const clipCache = new Map();   // file -> { key, result }

/** Detected clips for one replay, cached in memory for the session. */
export function analyze(file, { perspective } = {}) {
  const key = `${stamp(file)}:${perspective ?? ""}`;
  const hit = clipCache.get(file);
  if (hit?.key === key) return hit.result;
  const result = findClips(file, { perspective });
  clipCache.set(file, { key, result });
  return result;
}

// --- best-of, across many replays ------------------------------------------
// Analysing one replay costs ~240ms, so ranking a whole folder is a ~2 minute
// job the first time. The per-replay result is cached on disk against the same
// size+mtime stamp the header index uses, which makes every later run instant.
// The cache holds *unranked* clips so changing your connect code re-sorts
// rather than re-parses.

/** The local calendar day a replay belongs to (sessions run past midnight). */
export function dayOf(startAt) {
  if (!startAt) return "unknown";
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Every day that has replays, newest first, with counts for the picker. */
export function listDays() {
  const { replays } = scanReplays();
  const days = new Map();
  for (const r of replays) {
    const key = dayOf(r.startAt);
    const d = days.get(key) ?? { day: key, games: 0, players: new Set() };
    d.games++;
    for (const p of r.players) if (p.name) d.players.add(p.name);
    days.set(key, d);
  }
  return [...days.values()]
    .map((d) => ({ day: d.day, games: d.games, players: [...d.players].slice(0, 6) }))
    // Newest first, with any undated replays parked at the end rather than
    // sorting above the real days on the strength of the letter "u".
    .sort((a, b) => (a.day === "unknown") - (b.day === "unknown")
      || b.day.localeCompare(a.day));
}

let clipCacheDisk = null;
const loadClipCache = () => (clipCacheDisk ??= readJson(CLIPCACHE_FILE, {}));
const saveClipCache = () => writeJson(CLIPCACHE_FILE, clipCacheDisk ?? {});

/** Unranked clips for one replay, from disk cache when the file is unchanged. */
function rawClipsFor(file) {
  const cache = loadClipCache();
  let key;
  try { key = stamp(file); } catch { return null; }
  const hit = cache[file];
  if (hit?.key === key) return hit.result;
  const result = analyzeRaw(file);
  cache[file] = { key, result };
  return result;
}

/**
 * Rank clips across many replays at once.
 *
 * Deliberately cooperative: parsing is synchronous and blocks the event loop
 * for ~240ms per file, so it yields between replays. Without that the progress
 * the UI is polling for could never be served while the scan ran.
 */
export async function analyzeAll({ days = null, limit = 80, onProgress, shouldStop } = {}) {
  const cfg = getConfig();
  const { replays } = scanReplays();
  const wanted = days?.length
    ? replays.filter((r) => days.includes(dayOf(r.startAt)))
    : replays;

  const all = [];
  let done = 0;
  let parsed = 0;

  for (const r of wanted) {
    if (shouldStop?.()) break;
    try {
      const before = loadClipCache()[r.file]?.key;
      const raw = rawClipsFor(r.file);
      if (raw) {
        if (loadClipCache()[r.file]?.key !== before) parsed++;
        for (const c of rankFor(raw, cfg.perspective)) {
          all.push({
            ...c,
            replay: r.file,
            matchup: r.matchup,
            stage: r.stage,
            startAt: r.startAt,
            day: dayOf(r.startAt),
          });
        }
      }
    } catch { /* unreadable replay: the header index already noted it */ }
    done++;
    onProgress?.({ done, total: wanted.length });
    // Let the server answer progress polls between files.
    await new Promise((res) => setImmediate(res));
  }

  if (parsed) saveClipCache();
  all.sort((a, b) => b.score - a.score);
  return { total: wanted.length, scanned: done, clips: all.slice(0, limit) };
}

// --- draft previews --------------------------------------------------------
// Cheap throwaway renders, kept apart from the real clip library: they live in
// app data rather than the user's Videos folder, and are keyed by exactly what
// defines the clip, so re-previewing the same moment is free.

const DRAFTS_DIR = path.join(WOMBO_DATA, "drafts");
const DRAFTS_FILE = path.join(WOMBO_DATA, "drafts.json");

export const draftsDir = () => DRAFTS_DIR;

export function draftKey(clip) {
  const base = `${clip.replay}|${clip.startFrame}|${clip.endFrame}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
  return `d${(h >>> 0).toString(36)}`;
}

export function getDraft(key) {
  const all = readJson(DRAFTS_FILE, {});
  const d = all[key];
  if (!d) return null;
  if (!fs.existsSync(d.file)) { delete all[key]; writeJson(DRAFTS_FILE, all); return null; }
  return d;
}

export function saveDraft(key, record) {
  const all = readJson(DRAFTS_FILE, {});
  all[key] = { key, ...record, createdAt: new Date().toISOString() };
  writeJson(DRAFTS_FILE, all);
  return all[key];
}

/** Keep the drafts folder from growing forever - they are disposable. */
export function pruneDrafts(keep = 60) {
  const all = readJson(DRAFTS_FILE, {});
  const list = Object.values(all)
    .filter((d) => fs.existsSync(d.file))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const next = {};
  for (const d of list.slice(0, keep)) next[d.key] = d;
  for (const d of list.slice(keep)) { try { fs.rmSync(d.file, { force: true }); } catch { /* gone */ } }
  writeJson(DRAFTS_FILE, next);
}

// --- rendered clip library -------------------------------------------------

export function listClips() {
  const clips = readJson(CLIPS_FILE, []);
  // Drop entries whose file the user deleted from disk.
  const live = clips.filter((c) => fs.existsSync(c.file));
  if (live.length !== clips.length) writeJson(CLIPS_FILE, live);
  return live.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function addClip(clip) {
  const clips = readJson(CLIPS_FILE, []);
  clips.push(clip);
  writeJson(CLIPS_FILE, clips);
  return clip;
}

export function updateClip(id, patch) {
  const clips = readJson(CLIPS_FILE, []);
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return null;
  clips[i] = { ...clips[i], ...patch };
  writeJson(CLIPS_FILE, clips);
  return clips[i];
}

export function removeClip(id, { deleteFile = true } = {}) {
  const clips = readJson(CLIPS_FILE, []);
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return false;
  const [gone] = clips.splice(i, 1);
  writeJson(CLIPS_FILE, clips);
  if (deleteFile) { try { fs.rmSync(gone.file, { force: true }); } catch { /* already gone */ } }
  return true;
}

/** A filename that says what the clip is without being unwieldy. */
export function clipFileName(replayName, clip) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const kind = clip.tags?.includes("zero-to-death") ? "0-to-death"
    : clip.tags?.includes("spike") ? "spike"
      : clip.didKill ? "kill" : "combo";
  const base = path.basename(replayName, ".slp").replace(/^Game_/, "");
  // Only a DETECTED clip knows who did what to whom. A hand-marked range has
  // neither, and running those through here produced files actually called
  // "undefined-combo-on-undefined" - so fall back to the matchup.
  const who = clip.byChar && clip.onChar
    ? `${safe(clip.byChar)}-${kind}-on-${safe(clip.onChar)}`
    : safe(clip.matchup || clip.title || "clip");
  return `${base}_${who}_${clip.startFrame}.mp4`;
}
