// Wombo's page. One job: watch a replay, mark a start and an end, render that
// range to a video with a share link.
//
// The player is a real Dolphin window parked over #stage, which shapes almost
// everything here:
//  - Dolphin cannot be asked where it is, so position is tracked from the wall
//    clock: it plays at exactly 60fps, so frame = start + elapsed * 60.
//  - Dolphin's own hotkeys are unreachable (it ignores posted messages AND real
//    injected keystrokes), so pause is done by freezing the process.
//  - Dolphin's window floats above this page, so anything that should hide it
//    has to actually hide the window, not draw over it.

import { mountSuggestions, mountAutoTab } from "./auto.js";
import { checkList, tally, grainKey, grainLabel, dayOf } from "./filters.js";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** POST with no payload. `api(url)` alone sends a GET, which silently hits the
 *  wrong route - that is what made Stop player do nothing for so long. */
const post = (url, body = {}) => api(url, body);

const api = async (url, body) => {
  const res = await fetch(url, body ? {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {});
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
};

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}

const SHELL = typeof window.womboShell !== "undefined";
const FPS = 60;

const state = { replays: [], filtered: [], current: null, perspective: null };

const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// --- replay list -----------------------------------------------------------

const when = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

function renderReplays() {
  const list = $("#replayList");
  list.replaceChildren();
  for (const r of state.filtered.slice(0, 400)) {
    const li = el("li");
    li.classList.toggle("on", state.current?.file === r.file);
    const top = el("div", "rTop");
    top.append(el("span", "rMatch", r.matchup),
      el("span", "rMeta", r.durationSec ? mmss(r.durationSec) : ""));
    const names = r.players.map((p) => p.name || p.code || `P${p.port}`).join("  vs  ");
    li.append(top, el("div", "rMeta", `${names} · ${r.stage}`), el("div", "rMeta", when(r.startAt)));
    li.onclick = () => selectReplay(r);
    list.append(li);
  }
  $("#replayCount").textContent = `${state.filtered.length}`;
  $("#replayCount").title = state.hidden
    ? `${state.hidden} empty replays hidden (games that never started)` : "";
}

/**
 * Games that never really started - a disconnect at the character select, say -
 * are written as a replay with a handful of frames (lastFrame -123, duration
 * -2s). There is nothing in them to watch or clip, and trying to play one
 * leaves the player waiting for a replay that never begins, so they are kept
 * out of the list entirely.
 */
const playable = (r) => (r.durationSec ?? 0) > 1 && (r.lastFrame ?? 0) > 60;

// --- replay filters --------------------------------------------------------
// Which side is "you" comes from the connect code that appears in most of your
// replays. Without one there is no way to tell your character from theirs, so
// both lists fall back to matching either player rather than guessing.
let repGrain = "day";
let repFilters = null;

const mineIn = (r) => (state.perspective
  ? r.players.find((p) => p.code?.toUpperCase() === state.perspective.toUpperCase())
  : null);

function charsOf(r) {
  const me = mineIn(r);
  const them = me ? r.players.find((p) => p !== me) : null;
  return {
    mine: me ? [me.characterShort] : r.players.map((p) => p.characterShort),
    theirs: them ? [them.characterShort] : r.players.map((p) => p.characterShort),
  };
}

function passesFilters(r) {
  if (!repFilters) return true;
  const { when, mine, theirs, stage } = repFilters;
  if (!when.empty() && !when.has(grainKey(dayOf(r.startAt), repGrain))) return false;
  const c = charsOf(r);
  if (!mine.empty() && !c.mine.some((x) => mine.has(x))) return false;
  if (!theirs.empty() && !c.theirs.some((x) => theirs.has(x))) return false;
  if (!stage.empty() && !stage.has(r.stage)) return false;
  return true;
}

function applySearch() {
  const q = $("#search").value.trim().toLowerCase();
  const real = state.replays.filter(playable).filter(passesFilters);
  state.hidden = state.replays.length - state.replays.filter(playable).length;
  state.filtered = !q ? real : real.filter((r) =>
    (r.matchup + " " + r.stage + " " +
      r.players.map((p) => `${p.name} ${p.code} ${p.character}`).join(" ")
    ).toLowerCase().includes(q));
  renderReplays();
}

/** Build the filter lists from whatever the replay folder actually contains. */
function buildReplayFilters() {
  if (!repFilters) {
    repFilters = {
      when: checkList($("#repWhen"), { placeholder: "Find a date…", onChange: applySearch }),
      mine: checkList($("#repMine"), { placeholder: "Find a character…", onChange: applySearch }),
      theirs: checkList($("#repTheirs"), { placeholder: "Find a character…", onChange: applySearch }),
      stage: checkList($("#repStage"), { placeholder: "Find a stage…", onChange: applySearch }),
    };
    for (const b of document.querySelectorAll("#repGrain .seg")) {
      b.onclick = () => {
        if (b.dataset.grain === repGrain) return;
        repGrain = b.dataset.grain;
        document.querySelectorAll("#repGrain .seg")
          .forEach((x) => x.classList.toggle("on", x === b));
        // A ticked day means nothing once the list is showing months.
        repFilters.when.clear();
        refreshReplayFilters();
        applySearch();
      };
    }
    $("#repReset").onclick = () => {
      for (const f of Object.values(repFilters)) f.clear();
      applySearch();
    };
  }
  refreshReplayFilters();
}

function refreshReplayFilters() {
  const real = state.replays.filter(playable);
  repFilters.when.setItems(
    tally(real, (r) => grainKey(dayOf(r.startAt), repGrain))
      .sort((a, b) => String(b.value).localeCompare(String(a.value)))
      .map((i) => ({ ...i, label: grainLabel(i.value) })));
  repFilters.mine.setItems(tally(real, (r) => charsOf(r).mine));
  repFilters.theirs.setItems(tally(real, (r) => charsOf(r).theirs));
  repFilters.stage.setItems(tally(real, (r) => r.stage));
}

function selectReplay(r) {
  state.current = r;
  renderReplays();
  player.reset(r);
  showSuggestions?.(r);
}

// --- the player ------------------------------------------------------------

const player = {
  replay: null,
  lastFrame: 0,
  playing: false,
  paused: false,
  // Where playback started and when, so the position can be derived.
  originFrame: 0,
  originAt: 0,
  pausedAt: 0,
  markIn: null,
  markOut: null,
  tick: null,
  seeking: false,
  previewing: false,
  endTimer: null,

  reset(replay) {
    this.replay = replay;
    // A replay still being written has no recorded length. It can still be
    // played and clipped; we just cannot show a total or offer a seek bar.
    this.lastFrame = replay?.lastFrame ?? 0;
    this.unknownLength = !this.lastFrame;
    this.playing = false;
    this.paused = false;
    this.markIn = this.markOut = null;
    this.originFrame = 0;
    this.previewing = false;
    clearTimeout(this.endTimer);
    clearInterval(this.tick);
    this.tick = null;
    $("#tSeek").value = 0;
    $("#tTotal").textContent = this.unknownLength ? "—" : mmss(this.lastFrame / FPS);
    $("#tPlay").disabled = !replay;
    $("#tPlay").textContent = "▶";
    $("#tSeek").disabled = true;
    this.paint();
  },

  /**
   * Current frame, derived from the wall clock.
   *
   * Slippi's seek bar reports a true frame, but only while it is VISIBLE - wx
   * does not update a control that is not drawn, and we keep it hidden. So the
   * bar is used to seek, and the clock is derived and re-synced on every seek,
   * which keeps it honest because a seek is the only thing that moves playback
   * discontinuously.
   */
  frame() {
    if (!this.playing) return this.originFrame;
    const at = this.paused ? this.pausedAt : Date.now();
    const f = this.originFrame + ((at - this.originAt) / 1000) * FPS;
    return this.unknownLength ? f : Math.min(this.lastFrame, f);
  },

  paint() {
    const f = this.frame();
    $("#tTime").textContent = mmss(f / FPS);
    if (!this.seeking && !this.unknownLength) {
      $("#tSeek").value = Math.round((f / this.lastFrame) * 1000);
    }
    const on = this.playing && !this.seeking;
    $("#tMarkIn").disabled = !on;
    $("#tMarkOut").disabled = !on || this.markIn == null;
    $("#tClear").disabled = this.markIn == null && this.markOut == null;
    const haveRange = this.markIn != null && this.markOut != null && this.markOut > this.markIn;
    $("#tRender").disabled = !haveRange;
    $("#tPreview").disabled = !haveRange;

    const range = $("#tRange");
    if (this.markIn == null) { range.textContent = "no clip marked"; range.classList.remove("set"); }
    else if (this.markOut == null) {
      range.textContent = `start ${mmss(this.markIn / FPS)} — now mark the end`;
      range.classList.add("set");
    } else {
      range.textContent =
        `clip ${mmss(this.markIn / FPS)} → ${mmss(this.markOut / FPS)}  (${((this.markOut - this.markIn) / FPS).toFixed(1)}s)`;
      range.classList.add("set");
    }
  },

  /** Start (or restart) playback at a frame. */
  async playFrom(frame, { endFrame, retried = false } = {}) {
    if (!this.replay) return;
    // Un-freeze first. Seeking while paused leaves the emulation threads
    // suspended, so Dolphin never acts on the new position - the clock runs on
    // and it looks like it is playing with the sound missing.
    if (this.paused && SHELL) {
      await window.womboShell.setPaused(false);
      this.paused = false;
    }
    this.seeking = true;
    this.paused = false;
    $("#tPlay").textContent = "⏸";
    $("#stageCover").querySelector(".spinner").hidden = false;
    cover(this.previewing ? "Cueing the clip…" : "Buffering…");
    // Silence whatever is playing BEFORE measuring, so the baseline cannot be
    // inflated by the previous position still producing sound - otherwise the
    // very first reading looks like "new audio" and we uncover too early.
    if (SHELL) await window.womboShell.setPaused(true);
    const audioBase = SHELL
      ? (await api("/api/player/audio").catch(() => ({ bytes: 0 }))).bytes
      : 0;

    let res;
    try {
      res = await api("/api/player/play", {
        clip: {
          replay: this.replay.file,
          startFrame: Math.max(-123, Math.round(frame)),
          endFrame: endFrame ?? (this.lastFrame || 999999),
        },
      });
    } catch (err) {
      if (SHELL) await window.womboShell.setPaused(false);
      await uncover();
      this.seeking = false;
      return toast(err.message, true);
    }
    // Booting Melee and seeking inside a running replay need different rules.
    const booting = !!res?.booting;
    if (SHELL) await window.womboShell.setPaused(false);   // let it seek and play
    const started = await whenAudible({ timeout: booting ? 60000 : 20000, base: audioBase,
      from: Math.max(-123, Math.round(frame)) });
    if (!started.ok) {
      // Silence usually means the RUNNING Dolphin has stopped consuming the
      // comm file - once its queue is exhausted it can ignore new entries
      // entirely, so the write goes nowhere and nothing ever plays again. That
      // is not a bad replay, and telling the user their file is corrupt sends
      // them looking in the wrong place. Restart the player and try once more.
      if (!retried) {
        cover("Restarting the player…");
        await post("/api/player/stop");
        if (SHELL) await window.womboShell.dolphinDetached();
        return this.playFrom(frame, { endFrame, retried: true });
      }
      await uncover();
      this.seeking = false;
      this.playing = false;
      $("#tPlay").textContent = "▶";
      return toast("Could not get the player going, even after restarting it. "
        + "If it keeps happening, close Wombo and reopen it.", true);
    }
    this.originFrame = Math.max(0, Math.round(frame));
    this.originAt = Date.now();
    this.playing = true;
    this.seeking = false;
    $("#tSeek").disabled = this.unknownLength;
    clearInterval(this.tick);
    this.tick = setInterval(() => this.paint(), 100);
    await uncover();
    this.paint();
    updateChip();
  },

  async togglePause() {
    if (!this.playing) return this.playFrom(this.previewing ? this.markIn : 0);
    const next = !this.paused;
    // Stamp the moment of the press, not the moment the suspend lands. Freezing
    // the process takes a beat, and the clock is derived - if it kept counting
    // until the call returned, the reported position would drift every pause.
    const at = Date.now();
    const ok = SHELL ? (await window.womboShell.setPaused(next)).ok : false;
    if (!ok) return toast("Could not pause the player", true);
    if (next) {
      this.pausedAt = at;
    } else {
      this.originAt += at - this.pausedAt;   // skip the frozen interval
    }
    this.paused = next;
    $("#tPlay").textContent = next ? "▶" : "⏸";
    this.paint();
  },

  /**
   * Play just the marked range, so you can check a clip before rendering it.
   *
   * Dolphin does not stop at the end of a queue entry - it drops to Slippi's
   * idle screen and sits there - and nothing in its telemetry says the entry
   * finished. But we asked for exactly these frames, so the clip's own length
   * tells us when it is over, and the player is hidden again at that point.
   */
  /**
   * Play just the marked range.
   *
   * Seeks IN PLACE rather than re-issuing the replay. Re-issuing makes Melee
   * reload, and everything audible and visible about that reload leaks past the
   * cover: the menu selection sound, the garbled audio of the load itself, and
   * Slippi's 'Waiting for game' screen when the queue runs out at the end.
   * Seeking has none of that - the emulator never stops running the replay.
   */
  async previewMarked() {
    if (this.markIn == null || this.markOut == null) return;
    clearTimeout(this.endTimer);
    this.previewing = true;

    let seeked = false;
    if (SHELL && this.playing) {
      // A frozen emulator cannot act on a seek.
      if (this.paused) {
        await window.womboShell.setPaused(false);
        this.paused = false;
        $("#tPlay").textContent = "⏸";
      }
      const res = await window.womboShell.seekTo(this.markIn).catch(() => ({ ok: false }));
      if (res?.ok) {
        this.originFrame = this.markIn;
        this.originAt = Date.now();
        this.seeking = false;
        this.paint();
        seeked = true;
      }
    }
    // Nothing playing yet (or the seek bar was unreachable): fall back to
    // loading the range, which does reload but at least works.
    if (!seeked) await this.playFrom(this.markIn, { endFrame: this.markOut });
    if (!this.playing) { this.previewing = false; return; }

    const ms = ((this.markOut - this.markIn) / 60) * 1000;
    this.endTimer = setTimeout(async () => {
      if (!this.previewing) return;
      this.previewing = false;
      this.playing = false;
      clearInterval(this.tick);
      $("#tPlay").textContent = "▶";
      // Freeze it BEFORE hiding. Seeking in place means the replay just keeps
      // running past the end of the clip, so without this the audio carries on
      // playing under the 'finished' panel.
      if (SHELL) {
        await window.womboShell.setPaused(true);
        this.paused = true;
        await window.womboShell.setPlayerVisible(false);
      }
      $("#stageCoverText").textContent = "Preview finished — render it, or adjust the marks.";
      $("#stageCover").querySelector(".spinner").hidden = true;
      $("#stageCover").hidden = false;
      this.paint();
      // Leave the clock showing where the clip ended, not where playback got to.
      this.originFrame = this.markOut;
      this.originAt = Date.now();
    }, Math.max(400, ms));
  },
  mark(which) {
    const f = Math.round(this.frame());
    if (which === "in") { this.markIn = f; this.markOut = null; }
    else this.markOut = f;
    this.paint();
  },

  clearMarks() { this.markIn = this.markOut = null; this.paint(); },
};

// --- the cover -------------------------------------------------------------
// Dolphin has to be genuinely hidden, not drawn over: its window floats above
// this page. Hiding it also stops the boot looking like a second window opening,
// and hides Slippi's "Waiting for game" idle screen.

let coverPoll = null;

function cover(text) {
  $("#stageCoverText").textContent = text;
  $("#stageCover").hidden = false;
  $("#stageIdle").hidden = true;
  // Present the wait the way a video player presents buffering, rather than as
  // a stalled app: the bar keeps the position you asked for and shimmers.
  $("#transport").classList.add("buffering");
  $("#bufBar").hidden = false;
  if (SHELL) window.womboShell.setPlayerVisible(false);
}

function unbuffer() {
  $("#transport").classList.remove("buffering");
  $("#bufBar").hidden = true;
}

/**
 * Reveal the player with picture and sound starting together.
 *
 * Hiding the window does not mute Dolphin, so between playback actually
 * starting and us noticing, sound is already out - you hear the clip before you
 * see it. We cannot pause before it starts (noticing is what tells us it
 * started), but we can freeze it the instant we do, show the window on a real
 * frame, and let it go again. What leaks is then only the detection lag.
 */
async function uncover() {
  clearInterval(coverPoll);
  coverPoll = null;
  unbuffer();
  if (!SHELL) { $("#stageCover").hidden = true; return; }
  await window.womboShell.setPaused(true);      // stop the sound immediately
  await window.womboShell.setPlayerVisible(true);
  $("#stageCover").hidden = true;
  await window.womboShell.setPaused(false);     // and start them together
}

/**
 * Resolve when Dolphin is actually playing rather than seeking.
 *
 * FPS in Dolphin's window title is the only telemetry available, and it needs
 * reading carefully: Slippi's idle screen also runs at 60fps, so a reading of 60
 * proves nothing on its own. Only a dip (the seek) followed by a return to 60
 * means the replay is really running.
 */
/**
 * Resolve at the instant playback becomes audible.
 *
 * Dolphin writes its audio to a file that only grows while sound is actually
 * being produced, so the first byte past a baseline is exactly the moment the
 * clip starts making noise - and therefore exactly when the picture must
 * appear. This replaced watching FPS in the window title, which turned out to
 * be stuck at a constant value in every state (steady playback, forward seek,
 * backward seek), making it useless and leaving a blind timer in its place.
 */
/**
 * Resolve when Dolphin is really playing the position we asked for.
 *
 * Two signals, because either alone lies:
 *  - Audio, because Melee dumps sound while it is still LOADING. That is what
 *    made Preview reveal ~4 seconds of black.
 *  - The frame rate, because right after the queue is re-issued Dolphin still
 *    reports the OUTGOING playback's rate (measured 30fps for a moment, then
 *    0 through the reload), so it passes a threshold before anything is drawn.
 *
 * Dolphin's own seek bar does not lie: once its reported frame is at the
 * requested start AND advancing, the new replay is genuinely running.
 */
async function whenAudible({ timeout = 40000, base = null, from = null } = {}) {
  if (!SHELL) return { ok: true };
  if (base == null) base = (await api("/api/player/audio").catch(() => ({ bytes: 0 }))).bytes;
  const started = Date.now();
  let audible = false;
  let audibleAt = 0;
  let dipped = false;
  let advancing = 0;
  while (Date.now() - started < timeout) {
    if (!audible) {
      const { bytes } = await api("/api/player/audio").catch(() => ({ bytes: base }));
      // A shrink means Dolphin restarted and recreated the file - re-baseline
      // rather than waiting forever to exceed the previous session's size.
      if (bytes < base) base = bytes;
      else if (bytes > base) { audible = true; audibleAt = Date.now(); }
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    // Watch for the RELOAD, then for the recovery.
    //
    // Every 'has it started' signal is stale for a few hundred ms after the
    // queue is re-issued: audio keeps flowing, the seek bar keeps reporting the
    // outgoing position, and the title still shows the previous frame rate
    // (measured ~30fps for a beat, then 4, 0, 0, then 45+). Any threshold test
    // passes on that stale reading and reveals ~4s of black.
    //
    // The reload itself is unmistakable though: emulation drops to near zero
    // while the video thread keeps presenting. So wait to SEE it drop, and only
    // then wait for it to climb back.
    const st = await window.womboShell.stats().catch(() => null);
    const fps = st && typeof st.fps === "number" ? st.fps : null;
    if (fps == null) { await new Promise((r) => setTimeout(r, 120)); continue; }
    if (!dipped) {
      // A boot starts at zero anyway, so this is satisfied immediately there.
      if (fps < 10) dipped = true;
      // Do not wait forever for a dip that already happened before we looked.
      else if (Date.now() - audibleAt > 1500) dipped = true;
    } else if (fps >= 20) {
      if (++advancing >= 2) return { ok: true };
    } else {
      advancing = 0;
    }
    // Never hold the cover on the refinement alone - audio already proved the
    // replay is alive, so fall through rather than sitting here.
    if (Date.now() - audibleAt > 12000) return { ok: true };
    await new Promise((r) => setTimeout(r, 120));
  }
  // Out of time: show it anyway rather than sitting on a cover forever.
  return { ok: audible };
}

// --- rendering -------------------------------------------------------------

async function renderMarked() {
  const { replay, markIn, markOut } = player;
  if (!replay || markIn == null || markOut == null) return;
  const label = `${replay.matchup} ${mmss(markIn / FPS)}-${mmss(markOut / FPS)}`;
  try {
    await api("/api/render", {
      clips: [{
        replay: replay.file, startFrame: markIn, endFrame: markOut,
        label, matchup: replay.matchup, stage: replay.stage,
      }],
      quality: $("#quality").value,
    });
    toast("Rendering — it lands in My Clips in about 25 seconds");
  } catch (err) { toast(err.message, true); }
}

// --- clip library ----------------------------------------------------------

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
let libSig = null;

async function loadLibrary({ force = false } = {}) {
  const { clips } = await api("/api/library");
  $("#libCount").textContent = clips.length ? `(${clips.length})` : "";
  $("#libEmpty").hidden = clips.length > 0;

  // Rebuilding destroys every <video>, so only do it when something changed.
  const sig = clips.map((c) => `${c.id}:${c.url ?? ""}:${c.bytes}`).join("|");
  if (!force && sig === libSig) return;
  libSig = sig;

  const grid = $("#libGrid");
  grid.replaceChildren();
  for (const c of clips) {
    const card = el("div", "card");
    const v = el("video");
    v.src = `/media?id=${encodeURIComponent(c.id)}`;
    v.controls = true;
    v.preload = "metadata";
    v.addEventListener("loadedmetadata", () => { v.currentTime = v.duration / 3; }, { once: true });
    card.append(v);

    const body = el("div", "cardBody");
    body.append(el("h3", null, c.title));
    body.append(el("div", "dim", `${c.matchup ?? ""} ${c.stage ? "· " + c.stage : ""}`.trim()));
    body.append(el("div", "dim", `${c.durationSec}s · ${mb(c.bytes)} · ${c.quality}`));

    const row = el("div", "cardRow");
    // Parked, not removed: the upload path works, but every anonymous host
    // tested was either unreliable or short-lived, so a hosted link is not
    // something to promise testers yet. Copy for Discord covers it today.
    const shareBtn = el("button", "ghost", c.url ? "Get a new link" : "Get link");
    shareBtn.disabled = true;
    shareBtn.title = "Hosted links are not ready yet - use Copy for Discord";
    row.append(shareBtn);
    row.append(el("span", "soon", "coming soon"));

    // Posting attaches the file to a Discord webhook message, so the clip is
    // never hosted anywhere else - no link to go stale, and Discord renders a
    // native player. Only ever fires on this click.
    // The no-setup route: put the file on the clipboard and let them paste it
    // into any channel or DM with Ctrl+V. Discord does the upload itself, so
    // there is nothing to configure and nothing that can go stale.
    const copyClip = el("button", "primary", "Copy for Discord");
    copyClip.title = "Copies the video file - paste it into Discord with Ctrl+V";
    copyClip.onclick = async () => {
      const was = copyClip.textContent;
      copyClip.disabled = true;
      try {
        await api("/api/clipboard", { id: c.id });
        copyClip.textContent = "Copied — paste in Discord";
        setTimeout(() => { copyClip.textContent = was; copyClip.disabled = false; }, 2600);
      } catch (err) {
        copyClip.disabled = false;
        toast(err.message, true);
      }
    };
    row.append(copyClip);


    const del = el("button", "ghost", "Delete");
    del.onclick = async () => {
      if (!confirm(`Delete "${c.title}" from disk?`)) return;
      await api("/api/delete", { id: c.id });
      loadLibrary({ force: true });
    };
    row.append(del);
    body.append(row);

    if (c.url) {
      const link = el("div", "link");
      const inp = el("input");
      inp.value = c.url;
      inp.readOnly = true;
      inp.onclick = () => inp.select();
      const copy = el("button", "ghost", "Copy");
      copy.onclick = async () => { await navigator.clipboard.writeText(c.url); toast("Link copied"); };
      link.append(inp, copy);
      body.append(link);
    }
    card.append(body);
    grid.append(card);
  }
}

// --- render queue ----------------------------------------------------------

const seenDone = new Set();

async function pollJobs() {
  try {
    const { jobs } = await api("/api/jobs");
    const active = jobs.filter((j) => j.status === "queued" || j.status === "running" || j.status === "error");
    const foot = $("#queue");
    foot.hidden = active.length === 0;
    const rows = $("#queueRows");
    rows.replaceChildren();
    for (const j of active) {
      const row = el("div", `qRow ${j.status === "error" ? "error" : ""}`);
      row.append(el("span", null, j.title ?? "clip"));
      row.append(el("span", "qPhase", j.status === "error" ? "failed" : j.phase));
      const bar = el("div", "bar");
      const fill = el("i");
      fill.style.width = `${Math.round((j.pct ?? 0) * 100)}%`;
      bar.append(fill);
      row.append(bar);
      if (j.error) row.append(el("span", "dim", j.error));
      rows.append(row);
    }
    // Only refresh the library when a job has *newly* finished; finished jobs
    // stay in the list, so reacting to "any job done" would rebuild it forever.
    const fresh = jobs.filter((j) => j.status === "done" && !seenDone.has(j.id));
    if (fresh.length) {
      fresh.forEach((j) => seenDone.add(j.id));
      loadLibrary({ force: true });
      toast("Clip rendered — it's in My Clips");
    }
  } catch { /* server restarting */ }
}

async function updateChip() {
  const chip = $("#playerChip");
  try {
    const st = await api("/api/player");
    chip.hidden = !st.running;
    chip.textContent = st.running ? "Dolphin live" : "";
  } catch { chip.hidden = true; }
}

// --- wiring ----------------------------------------------------------------

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
    document.querySelectorAll(".tabpane").forEach((p) =>
      p.classList.toggle("on", p.id === `tab-${tab.dataset.tab}`));
    // One player, moved to whichever tab is showing. Duplicating it would mean
    // two stages competing for the one Dolphin window, and the Auto Clips tab
    // is supposed to behave exactly like the replay player.
    const host = tab.dataset.tab === "auto" ? $("#autoPlayerHost")
      : tab.dataset.tab === "replays" ? $("#replayPlayerHost") : null;
    if (host && $("#playerPane").parentElement !== host) host.append($("#playerPane"));
    // The player must not float over the clip library.
    if (SHELL) window.womboShell.setPlayerVisible(!!host && player.playing);
    if (host) reportStage?.();
    if (tab.dataset.tab === "library") loadLibrary();
    if (tab.dataset.tab === "auto") autoTab?.open();
  };
}

$("#search").oninput = applySearch;
$("#rescan").onclick = () => load(true);
$("#tPlay").onclick = () => player.togglePause();
$("#tMarkIn").onclick = () => player.mark("in");
$("#tMarkOut").onclick = () => player.mark("out");
$("#tClear").onclick = () => player.clearMarks();
$("#tPreview").onclick = () => player.previewMarked();
$("#tRender").onclick = renderMarked;
$("#quality").onchange = () => api("/api/config", { quality: $("#quality").value });

// The webhook is a secret - it is never echoed back from the server, so the

$("#tStop").onclick = async () => {
  clearInterval(player.tick);
  clearTimeout(player.endTimer);
  unbuffer();
  player.previewing = false;
  await post("/api/player/stop");
  player.playing = false;
  if (SHELL) await window.womboShell.dolphinDetached();
  $("#stageCover").hidden = true;
  $("#stageIdle").hidden = false;
  $("#tPlay").textContent = "▶";
  $("#tSeek").disabled = true;
  updateChip();
};

// Seeking: only act on release. Every jump is a real re-simulate inside Dolphin,
// so scrubbing live would queue up seconds of work per pixel moved.
$("#tSeek").oninput = () => {
  player.seeking = true;
  $("#tTime").textContent = mmss((Number($("#tSeek").value) / 1000 * player.lastFrame) / FPS);
};
$("#tSeek").onchange = async () => {
  // Dragging the bar leaves preview mode - you are watching the replay again.
  player.previewing = false;
  clearTimeout(player.endTimer);
  const frame = Math.round((Number($("#tSeek").value) / 1000) * player.lastFrame);

  // In-place seek through Slippi's own bar: instant, and Melee does not reload,
  // so there is no start jingle and no white flash. Falls back to re-issuing the
  // replay only if the bar is not reachable.
  if (SHELL && player.playing) {
    // A frozen emulator cannot act on a seek, and this path bypasses playFrom,
    // which used to be what un-froze it. Resume first or the clock stops dead.
    if (player.paused) {
      await window.womboShell.setPaused(false);
      player.paused = false;
      $("#tPlay").textContent = "⏸";
    }
    const res = await window.womboShell.seekTo(frame).catch(() => ({ ok: false }));
    if (res?.ok) {
      player.originFrame = frame;      // re-anchor the clock to the new position
      player.originAt = Date.now();
      // The seek is finished, so say so. oninput raises this flag and playFrom
      // used to be what lowered it again - this path returns before ever
      // reaching playFrom, and leaving it raised greys out the clip buttons
      // and stops the bar tracking playback for the rest of the session.
      player.seeking = false;
      player.paint();
      return;
    }
  }
  player.playFrom(frame);
};

// Set once the stage reporter exists, so switching tabs can re-report the
// stage's new position - the player is moved between the two tabs.
let reportStage = null;
if (SHELL) {
  const report = () => {
    const r = $("#stage").getBoundingClientRect();
    window.womboShell.setStageBounds({
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    });
  };
  new ResizeObserver(report).observe($("#stage"));
  window.addEventListener("resize", report);
  reportStage = report;
  report();
}

async function load(force = false) {
  const st = await api("/api/state");
  $("#quality").replaceChildren(...st.qualities.map((q) => {
    const o = el("option", null, q.label);
    o.value = q.id;
    return o;
  }));
  $("#quality").value = st.config.quality;
  // Nothing renders without ffmpeg, so say so plainly rather than letting the
  // first render fail with an error nobody can act on.
  $("#needFfmpeg").hidden = st.ffmpegOk !== false;

  $("#replayCount").textContent = "scanning…";
  const data = await api(`/api/replays${force ? "?force=1" : ""}`);
  state.replays = data.replays;
  // Which connect code is yours, so "your character" can mean anything.
  state.perspective = data.perspective ?? null;
  buildReplayFilters();
  applySearch();
  loadLibrary();
  updateChip();
}

// --- suggested clips -------------------------------------------------------

/**
 * Open a suggestion in the player.
 *
 * The marks are set to the suggested range, so a suggestion arrives in exactly
 * the state a hand-marked clip would - ready to nudge, preview or render. If it
 * belongs to a different replay than the one open, that replay is selected
 * first; the player reloads for that, which is unavoidable when the file
 * changes.
 */
async function openSuggestion(c) {
  // No replay on the clip means it came from the panel under the player, which
  // only ever shows the open replay.
  const wasCurrent = !c.replay || state.current?.file === c.replay;
  if (!wasCurrent) {
    const r = state.replays.find((x) => x.file === c.replay);
    if (!r) return toast("That replay is no longer in the folder.", true);
    selectReplay(r);
  }
  player.markIn = c.startFrame;
  player.markOut = c.endFrame;
  player.paint();
  await player.previewMarked();
}

// The player markup is authored outside both tabs so neither owns it. Put it
// in the Replays tab to start with; switching tabs moves it.
$("#replayPlayerHost").append($("#playerPane"));

const showSuggestions = mountSuggestions({ api, mmss, FPS, onPick: openSuggestion });
const autoTab = mountAutoTab({ api, mmss, when, onPick: openSuggestion });
load().catch((e) => toast(e.message, true));
setInterval(pollJobs, 1000);
