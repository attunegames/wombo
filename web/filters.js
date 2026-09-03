// A checkbox filter list with a search box over it.
//
// Used everywhere something has more options than fits on screen - characters
// (26), stages, players, days. Ticking is multi-select because "show me Fox AND
// Falco" is a normal thing to want, and the search only narrows what is
// LISTED, never what is ticked: typing to find one character must not silently
// drop a selection you made earlier.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * @param host     element to build inside
 * @param opts.placeholder  search box placeholder
 * @param opts.onChange     called whenever the selection changes
 * @param opts.searchAfter  only show the search box once there are this many
 *                          options - a list of four does not need one
 */
export function checkList(host, { placeholder = "Search…", onChange, searchAfter = 8 } = {}) {
  const selected = new Set();
  let items = [];

  const search = el("input", "filterSearch");
  search.type = "search";
  search.placeholder = placeholder;
  search.autocomplete = "off";
  search.spellcheck = false;

  const list = el("div", "checkList");
  const empty = el("p", "dim fHint", "nothing matches");
  empty.hidden = true;

  host.replaceChildren(search, list, empty);

  function paint() {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    let shown = 0;
    for (const it of items) {
      // A ticked option always stays visible, so you can see and undo what is
      // selected even while the search is narrowed to something else.
      const hit = !q || it.label.toLowerCase().includes(q) || selected.has(it.value);
      if (!hit) continue;
      shown += 1;
      const row = el("label", "fRow");
      const box = el("input");
      box.type = "checkbox";
      box.value = it.value;
      box.checked = selected.has(it.value);
      box.onchange = () => {
        if (box.checked) selected.add(it.value); else selected.delete(it.value);
        onChange?.(new Set(selected));
      };
      row.append(box, document.createTextNode(" " + it.label));
      if (it.count != null) row.append(el("span", "dayGames", String(it.count)));
      list.append(row);
    }
    empty.hidden = shown > 0;
    search.hidden = items.length < searchAfter;
  }

  search.oninput = paint;

  return {
    /** Replace the options. Selections for values that still exist are kept. */
    setItems(next) {
      items = next;
      const live = new Set(next.map((i) => i.value));
      for (const v of [...selected]) if (!live.has(v)) selected.delete(v);
      paint();
    },
    selected: () => new Set(selected),
    /** True when nothing is ticked, which every filter treats as "allow all". */
    empty: () => selected.size === 0,
    has: (v) => selected.has(v),
    clear() {
      selected.clear();
      search.value = "";
      paint();
    },
  };
}

/** Count how often each value appears, for the "12" beside an option. */
export function tally(rows, pick) {
  const counts = new Map();
  for (const r of rows) {
    for (const v of [pick(r)].flat()) {
      if (v == null || v === "") continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => ({ value, label: String(value), count }));
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** "2026-08-30" narrowed to the chosen grain, with "unknown" left whole. */
export const grainKey = (day, grain) => (day === "unknown" ? "unknown"
  : grain === "year" ? day.slice(0, 4)
    : grain === "month" ? day.slice(0, 7)
      : day);

export function grainLabel(key) {
  if (key === "unknown") return "undated";
  if (/^\d{4}$/.test(key)) return key;
  if (/^\d{4}-\d{2}$/.test(key)) return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  return key;
}

/** The local calendar day of an ISO timestamp, matching the server's dayOf. */
export function dayOf(startAt) {
  if (!startAt) return "unknown";
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
