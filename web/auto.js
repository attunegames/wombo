// Suggested clips: the ones Wombo finds by reading the replays, rather than
// the ones you mark by hand.
//
// Two surfaces, one detector:
//  - a list under the manual clip controls, for the replay you have open
//  - the Auto Clips tab, which filters every suggestion across every replay
//
// Both drive the SAME player. The player markup is moved between tabs rather
// than duplicated, so anything that works on a replay works here too - marking,
// previewing, rendering, seeking.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// Tags worth offering as filters, in the order they should read. The detector
// can emit an N-hit tag for any count, so those are folded into one "combo".
const TAG_FILTERS = [
  ["zero-to-death", "0-to-death", "hot"],
  ["kill", "Kill", ""],
  ["early-kill", "Early kill", "warm"],
  ["spike", "Spike", "hot"],
  ["side-ko", "Side KO", ""],
  ["read", "Hard read", "warm"],
  ["big-damage", "Big damage", ""],
  ["fast", "Fast punish", ""],
  ["combo", "Long combo (5+)", ""],
];

const TAG_CLASS = new Map(TAG_FILTERS.map(([id, , cls]) => [id, cls]));
const isCombo = (t) => /^\d+-hit$/.test(t);

export function tagChips(tags, yours) {
  const wrap = el("span", "sTags");
  if (yours === true) wrap.append(el("span", "tag mine", "you"));
  else if (yours === false) wrap.append(el("span", "tag", "opponent"));
  for (const t of tags) {
    const cls = isCombo(t) ? "" : (TAG_CLASS.get(t) ?? "");
    wrap.append(el("span", `tag ${cls}`.trim(), t));
  }
  return wrap;
}

// --- suggestions for the open replay ---------------------------------------

/**
 * Fill the panel under the clip controls with what the detector found in this
 * replay. Clicking one marks that range, so it lands in exactly the state a
 * hand-made clip would - ready to preview, adjust or render.
 */
export function mountSuggestions({ api, mmss, FPS, onPick }) {
  const list = $("#suggestList");
  const count = $("#suggestCount");
  let token = 0;

  $("#suggestToggle").onclick = () => {
    const pane = $("#suggestPane");
    pane.classList.toggle("collapsed");
    $("#suggestToggle").textContent = pane.classList.contains("collapsed") ? "Show" : "Hide";
  };

  return async function show(replay) {
    const mine = ++token;
    list.replaceChildren();
    if (!replay) { count.textContent = ""; return; }
    count.textContent = "reading the replay…";
    let res;
    try {
      res = await api(`/api/analyze?file=${encodeURIComponent(replay.file)}`);
    } catch (err) {
      if (mine === token) count.textContent = `could not read it: ${err.message}`;
      return;
    }
    if (mine !== token) return;    // a different replay was picked meanwhile

    const clips = res?.clips ?? [];
    count.textContent = clips.length ? `${clips.length} found` : "nothing stood out";
    for (const c of clips) {
      const li = el("li");
      li.append(
        el("span", "sWhen", mmss(c.startFrame / FPS)),
        el("span", "sTitle", c.label ?? "clip"),
        tagChips(c.tags, c.yours),
      );
      // Stamp the source file on. Per-replay suggestions come from
      // /api/analyze, which has no reason to repeat the file on every clip -
      // only the cross-replay scan adds it - and the handler needs it to know
      // which replay to open.
      li.onclick = () => onPick({ ...c, replay: replay.file });
      list.append(li);
    }
  };
}

// --- the Auto Clips tab ----------------------------------------------------

const SORTS = {
  startAt: (a, b) => String(b.startAt ?? "").localeCompare(String(a.startAt ?? "")),
  label: (a, b) => String(a.label ?? "").localeCompare(String(b.label ?? "")),
  byName: (a, b) => String(a.byName ?? "").localeCompare(String(b.byName ?? "")),
  onName: (a, b) => String(a.onName ?? "").localeCompare(String(b.onName ?? "")),
  tags: (a, b) => (b.tags?.length ?? 0) - (a.tags?.length ?? 0),
  damage: (a, b) => b.damage - a.damage,
  hitCount: (a, b) => b.hitCount - a.hitCount,
  durationSec: (a, b) => b.durationSec - a.durationSec,
  score: (a, b) => b.score - a.score,
};

export function mountAutoTab({ api, mmss, when, onPick }) {
  let all = [];              // everything the scan found
  let shown = [];            // what survives the filters
  let sortKey = "score";
  let sortDir = 1;           // 1 = as the comparator says, -1 = reversed
  let picked = null;
  let polling = null;
  let days = [];             // day keys sent to the server; empty means all
  let allDays = [];          // every day the library has, newest first
  let grain = "day";         // day | month | year
  let picks = new Set();     // what is ticked, at the CURRENT granularity

  // Tag checkboxes are built once; the character and player lists depend on
  // what the scan actually turned up, so they are filled in after it lands.
  const tagBox = $("#fTags");
  for (const [id, label] of TAG_FILTERS) {
    const row = el("label", "fRow");
    const box = el("input");
    box.type = "checkbox";
    box.value = id;
    box.onchange = render;
    row.append(box, document.createTextNode(" " + label));
    tagBox.append(row);
  }

  /**
   * The day filter goes to the SERVER, unlike every other filter here.
   *
   * The pool is the top few thousand clips across everything, so filtering it
   * client-side would silently drop a quiet day's clips - they never made the
   * global cut. Re-scanning for the chosen days re-ranks within them instead,
   * and it is cheap after the first pass because each replay's clips are cached
   * on disk.
   */
  async function loadDays() {
    try { allDays = (await api("/api/days")).days ?? []; } catch { return; }
    renderDayList();
  }

  /** "unknown" has no date in it, so it stays whole at every granularity. */
  const grainKey = (day, g) => (day === "unknown" ? "unknown"
    : g === "year" ? day.slice(0, 4)
      : g === "month" ? day.slice(0, 7)
        : day);

  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  function grainLabel(key) {
    if (key === "unknown") return "undated";
    if (/^\d{4}$/.test(key)) return key;
    if (/^\d{4}-\d{2}$/.test(key)) {
      return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    }
    return key;
  }

  /** Rebuild the date list for the chosen granularity, keeping games counts. */
  function renderDayList() {
    const groups = new Map();
    for (const d of allDays) {
      const key = grainKey(d.day, grain);
      const g = groups.get(key) ?? { key, games: 0, days: [] };
      g.games += d.games;
      g.days.push(d.day);
      groups.set(key, g);
    }

    const box = $("#fDays");
    box.replaceChildren();
    for (const g of groups.values()) {
      const row = el("label", "fRow");
      const cb = el("input");
      cb.type = "checkbox";
      cb.value = g.key;
      cb.checked = picks.has(g.key);
      cb.onchange = () => {
        if (cb.checked) picks.add(g.key); else picks.delete(g.key);
        // The server only understands day keys, so a month or a year is sent as
        // every day inside it. That keeps /api/best unchanged and still gets a
        // proper re-rank within the chosen span.
        days = [...groups.values()]
          .filter((x) => picks.has(x.key))
          .flatMap((x) => x.days);
        rescan();
      };
      row.append(cb, document.createTextNode(" " + grainLabel(g.key)),
        el("span", "dayGames", `${g.games}`));
      box.append(row);
    }
  }

  for (const b of document.querySelectorAll("#fGrain .seg")) {
    b.onclick = () => {
      if (b.dataset.grain === grain) return;
      grain = b.dataset.grain;
      document.querySelectorAll("#fGrain .seg")
        .forEach((x) => x.classList.toggle("on", x === b));
      // Selections do not survive a change of granularity - a ticked day has no
      // obvious meaning once the list is showing months.
      const had = picks.size;
      picks.clear();
      days = [];
      renderDayList();
      if (had) rescan();
    };
  }

  const checkedTags = () =>
    [...tagBox.querySelectorAll("input:checked")].map((i) => i.value);

  const who = () => document.querySelector("input[name=autoWho]:checked")?.value ?? "all";

  function matches(c) {
    const w = who();
    if (w === "mine" && c.yours !== true) return false;
    if (w === "theirs" && c.yours !== false) return false;

    const tags = checkedTags();
    if (tags.length) {
      const has = tags.some((t) => (t === "combo"
        ? (c.tags ?? []).some(isCombo)
        : (c.tags ?? []).includes(t)));
      if (!has) return false;
    }

    const byChar = $("#fByChar").value;
    if (byChar && c.byChar !== byChar) return false;
    const onChar = $("#fOnChar").value;
    if (onChar && c.onChar !== onChar) return false;
    const p = $("#fPlayer").value;
    if (p && c.byName !== p) return false;
    if (c.damage < Number($("#fDamage").value)) return false;
    return true;
  }

  function render() {
    const dmg = Number($("#fDamage").value);
    $("#fDamageVal").textContent = dmg ? `${dmg}% or more` : "any";

    shown = all.filter(matches).sort((a, b) => (SORTS[sortKey] ?? SORTS.score)(a, b) * sortDir);
    $("#autoShown").textContent = all.length
      ? `${shown.length} of ${all.length}` : "";
    $("#autoEmpty").hidden = shown.length > 0 || !all.length;

    const body = $("#autoRows");
    body.replaceChildren();
    // Capped for the DOM's sake: the pool can run to thousands and nobody
    // scrolls past a few hundred ranked suggestions.
    for (const c of shown.slice(0, 400)) {
      const tr = el("tr");
      tr.classList.toggle("on", picked && sameClip(picked, c));
      const tagCell = el("td");
      tagCell.append(tagChips(c.tags ?? [], c.yours));
      tr.append(
        el("td", "rowWhen", when(c.startAt)),
        el("td", null, c.label ?? ""),
        el("td", "rowWho", `${c.byName} (${c.byChar})`),
        el("td", "rowWho", `${c.onName} (${c.onChar})`),
        tagCell,
        el("td", "num", String(c.damage)),
        el("td", "num", String(c.hitCount)),
        el("td", "num", `${c.durationSec}s`),
        el("td", "num", String(c.score)),
      );
      tr.onclick = () => { picked = c; render(); onPick(c); };
      body.append(tr);
    }
  }

  function fillChoices() {
    const byChars = new Set();
    const onChars = new Set();
    const players = new Set();
    for (const c of all) {
      if (c.byChar) byChars.add(c.byChar);
      if (c.onChar) onChars.add(c.onChar);
      if (c.byName) players.add(c.byName);
    }
    fillSelect($("#fByChar"), byChars, "Any character");
    fillSelect($("#fOnChar"), onChars, "Any character");
    fillSelect($("#fPlayer"), players, "Any player");
  }

  function fillSelect(sel, values, anyLabel) {
    const keep = sel.value;
    sel.replaceChildren();
    sel.append(new Option(anyLabel, ""));
    for (const v of [...values].sort()) sel.append(new Option(v, v));
    sel.value = [...values].includes(keep) ? keep : "";
    sel.onchange = render;
  }

  async function poll() {
    let res;
    try {
      const q = days.length ? `&days=${encodeURIComponent(days.join(","))}` : "";
      res = await api(`/api/best?limit=4000${q}`);
    } catch (err) {
      $("#autoStatus").textContent = `scan failed: ${err.message}`;
      return;
    }
    const bar = $("#autoBar").querySelector("i");
    if (res.status === "scanning") {
      const pctDone = res.total ? Math.round((res.done / res.total) * 100) : 0;
      $("#autoStatus").textContent = `Reading replays… ${res.done}/${res.total || "?"}`;
      $("#autoBar").hidden = false;
      bar.style.width = `${pctDone}%`;
      polling = setTimeout(poll, 700);
      return;
    }
    $("#autoBar").hidden = true;
    if (res.status === "error") {
      $("#autoStatus").textContent = `scan failed: ${res.error}`;
      return;
    }
    all = res.clips ?? [];
    const scope = !picks.size ? ""
      : picks.size === 1 ? ` in ${grainLabel([...picks][0])}`
        : ` across ${picks.size} ${grain}s`;
    $("#autoStatus").textContent = `${all.length} suggestions from ${res.total} replays${scope}`;
    $("#autoCount").textContent = all.length ? `(${all.length})` : "";
    fillChoices();
    render();
  }

  for (const th of document.querySelectorAll("#autoTable th")) {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (!key) return;
      // Same column again reverses it, a new column starts in its natural order.
      sortDir = key === sortKey ? -sortDir : 1;
      sortKey = key;
      document.querySelectorAll("#autoTable th")
        .forEach((h) => h.classList.toggle("sorted", h === th));
      render();
    };
  }

  for (const r of document.querySelectorAll("input[name=autoWho]")) r.onchange = render;
  $("#fDamage").oninput = render;
  $("#autoReset").onclick = () => {
    tagBox.querySelectorAll("input").forEach((i) => { i.checked = false; });
    document.querySelector("input[name=autoWho][value=all]").checked = true;
    $("#fByChar").value = "";
    $("#fOnChar").value = "";
    $("#fPlayer").value = "";
    $("#fDamage").value = 0;
    const hadDays = days.length;
    picks.clear();
    $("#fDays").querySelectorAll("input").forEach((i) => { i.checked = false; });
    days = [];
    // Clearing a day selection widens the scan, so it has to go back to the
    // server rather than just re-filtering what is already loaded.
    if (hadDays) return rescan();
    render();
  };
  function rescan() {
    clearTimeout(polling);
    polling = null;
    all = [];
    picked = null;
    $("#autoStatus").textContent = "Reading replays…";
    render();
    poll();
  }

  $("#autoRescan").onclick = rescan;

  return {
    /** Called when the tab is opened; the scan is only started on first look. */
    open() {
      if (!allDays.length) loadDays();
      if (!all.length && !polling) poll();
    },
  };
}

/** Two suggestions are the same moment if they are the same range of the same replay. */
export function sameClip(a, b) {
  return a && b && a.replay === b.replay && a.startFrame === b.startFrame;
}
