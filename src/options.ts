import {
  getSettings,
  getSnoozed,
  getClosed,
  getFavicons,
  hostOf,
  usableIcon,
  fmtDateTime,
  fmtTime,
  placeName,
  placeStyle,
  type Settings,
  type ClosedTab,
  type ToastItem,
} from "./shared";
import { iconNode, Globe, ChevronRight, X } from "./icons";
import "./toast"; // registers window.__tabSweeperToast for the Preview button

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const days = $<HTMLInputElement>("days");
const skipPinned = $<HTMLInputElement>("skipPinned");
const skipAudible = $<HTMLInputElement>("skipAudible");
const toast = $<HTMLInputElement>("toast");
const chips = $("chips");
const chipInput = $<HTMLInputElement>("chipInput");

const posX = $<HTMLInputElement>("posX");
const posY = $<HTMLInputElement>("posY");
const screen = $("screen");
const mini = $("mini");

let whitelist: string[] = [];
let place = { x: 100, y: 100 };
let favicons: Record<string, string> = {};

// ---------- Small DOM helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const bareHost = (url: string) => hostOf(url).replace(/^www\./, "");

/** Favicon with a Lucide globe fallback when missing or broken. */
function fav(url: string | undefined, host?: string): HTMLSpanElement {
  const wrap = el("span", "fav");
  const src = usableIcon(url) ?? (host ? favicons[host] ?? favicons[`www.${host}`] : undefined);
  const globe = () => wrap.replaceChildren(iconNode(Globe, 16));
  if (src) {
    const img = el("img");
    img.alt = "";
    img.src = src;
    img.onerror = globe;
    wrap.append(img);
  } else globe();
  return wrap;
}

/** Text-only action button. */
function act(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const b = el("button", "link" + (danger ? " danger" : ""), label);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** One 40px table row: icon, title, secondary text, right-aligned value, actions on hover. */
function tr(opts: {
  lead?: HTMLElement;
  icon: HTMLElement;
  url?: string;
  title: string;
  titleClass?: string;
  sub?: string;
  num?: string;
  numTitle?: string;
  actions: HTMLElement[];
}): HTMLDivElement {
  const r = el("div", "tr");
  if (opts.lead) r.append(opts.lead);
  r.append(opts.icon);
  const cls = "title" + (opts.titleClass ? ` ${opts.titleClass}` : "");
  if (opts.url) {
    const a = el("a", cls, opts.title || opts.url);
    a.href = opts.url;
    a.target = "_blank";
    a.title = opts.url;
    r.append(a);
  } else r.append(el("span", cls, opts.title));
  if (opts.sub) r.append(el("span", "sub", opts.sub));
  if (opts.num) {
    const n = el("span", "num hide-on-hover", opts.num);
    if (opts.numTitle) n.title = opts.numTitle;
    r.append(n);
  }
  const acts = el("div", "acts");
  acts.append(...opts.actions);
  r.append(acts);
  return r;
}

/** "Today 9:00", "Tomorrow 9:00", "Mon 24 Nov 9:00". */
function when(ts: number): string {
  const d = new Date(ts);
  const dayStr = (offset: number) => {
    const x = new Date();
    x.setDate(x.getDate() + offset);
    return x.toDateString();
  };
  const ds = d.toDateString();
  const label =
    ds === dayStr(0) ? "Today"
    : ds === dayStr(1) ? "Tomorrow"
    : ds === dayStr(-1) ? "Yesterday"
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${label} ${fmtTime(d)}`;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).replace(/^\/$/, "") || u.hostname;
  } catch {
    return url;
  }
}

let statusTimer: number | undefined;
function flash(text: string): void {
  const s = $("status");
  s.textContent = text;
  s.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => s.classList.remove("show"), 1600);
}

// ---------- Settings (autosaved) ----------

async function save(): Promise<void> {
  const settings: Settings = {
    days: Math.max(0, Math.min(365, Math.round(Number(days.value) || 0))),
    skipPinned: skipPinned.checked,
    skipAudible: skipAudible.checked,
    whitelist,
    toast: toast.checked,
    toastX: place.x,
    toastY: place.y,
  };
  days.value = String(settings.days);
  await browser.storage.local.set({ settings });
  flash("Saved");
}

function normalizeHost(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  try {
    s = new URL(s.includes("://") ? s : `https://${s}`).hostname;
  } catch {
    return "";
  }
  return s.replace(/^www\./, "");
}

function renderChips(): void {
  chips.querySelectorAll(".chip").forEach((c) => c.remove());
  for (const host of whitelist) {
    const chip = el("span", "chip");
    chip.append(fav(undefined, host), host);
    const x = el("button");
    x.setAttribute("aria-label", `Remove ${host}`);
    x.append(iconNode(X, 14));
    x.addEventListener("click", () => {
      whitelist = whitelist.filter((h) => h !== host);
      renderChips();
      save();
    });
    chip.append(x);
    chips.insertBefore(chip, chipInput);
  }
}

function addChip(): void {
  const added = chipInput.value.split(/[\s,]+/).map(normalizeHost).filter((h) => h && !whitelist.includes(h));
  chipInput.value = "";
  if (!added.length) return;
  whitelist.push(...added);
  renderChips();
  save();
}

chipInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addChip();
  } else if (e.key === "Backspace" && !chipInput.value && whitelist.length) {
    whitelist.pop();
    renderChips();
    save();
  }
});
chipInput.addEventListener("blur", addChip);
chips.addEventListener("click", (e) => e.target === chips && chipInput.focus());

days.addEventListener("change", save);
$("dec").addEventListener("click", () => {
  days.value = String(Math.max(0, (Number(days.value) || 0) - 1));
  save();
});
$("inc").addEventListener("click", () => {
  days.value = String(Math.min(365, (Number(days.value) || 0) + 1));
  save();
});
skipPinned.addEventListener("change", save);
skipAudible.addEventListener("change", save);

toast.addEventListener("change", () => {
  if (!toast.checked) return void save();
  // Must be called directly from the click to count as a user action.
  browser.permissions.request({ origins: ["<all_urls>"] }).then((ok) => {
    toast.checked = ok;
    save();
  });
});

$("previewToast").addEventListener("click", (e) => {
  e.preventDefault();
  const items: ToastItem[] = [
    { title: "That article you were going to read later", host: "example.com" },
    { title: "Docs you opened three weeks ago", host: "developer.mozilla.org" },
  ];
  (window as any).__tabSweeperToast?.(items, place);
});

// ---------- Toast position (live preview) ----------

const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

function renderPlace(): void {
  Object.assign(mini.style, placeStyle(place.x, place.y, 4));
  posX.value = String(place.x);
  posY.value = String(place.y);
  $("posName").textContent = placeName(place.x, place.y) ?? "Custom";
  screen.querySelectorAll<HTMLButtonElement>(".spot").forEach((b) => {
    const on = Number(b.dataset.x) === place.x && Number(b.dataset.y) === place.y;
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", placeName(Number(b.dataset.x), Number(b.dataset.y))!);
  });
}

function setPlace(x: number, y: number, persist = true): void {
  place = { x: clampPct(x), y: clampPct(y) };
  renderPlace();
  if (persist) save();
}

screen.querySelectorAll<HTMLButtonElement>(".spot").forEach((b) =>
  b.addEventListener("click", () => setPlace(Number(b.dataset.x), Number(b.dataset.y))),
);
for (const input of [posX, posY]) input.addEventListener("change", () => setPlace(Number(posX.value) || 0, Number(posY.value) || 0));

// Drag the mini toast anywhere; it snaps to a corner, edge middle or the center when close.
mini.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  mini.setPointerCapture(e.pointerId);
  mini.classList.add("dragging");
  const r = screen.getBoundingClientRect();
  const m = mini.getBoundingClientRect();
  // Keep the grab point under the pointer.
  const gx = e.clientX - m.left, gy = e.clientY - m.top;
  const move = (ev: PointerEvent) => {
    const free = (v: number, size: number, span: number) => Math.max(0, Math.min(1, (v - 4) / (span - 8 - size))) * 100;
    let x = free(ev.clientX - gx - r.left, m.width, r.width);
    let y = free(ev.clientY - gy - r.top, m.height, r.height);
    const snap = (v: number) => ([0, 50, 100].find((s) => Math.abs(s - v) < 4) ?? v);
    x = snap(x);
    y = snap(y);
    setPlace(x, y, false);
  };
  const up = () => {
    mini.classList.remove("dragging");
    mini.removeEventListener("pointermove", move);
    mini.removeEventListener("pointerup", up);
    mini.removeEventListener("pointercancel", up);
    save();
  };
  mini.addEventListener("pointermove", move);
  mini.addEventListener("pointerup", up);
  mini.addEventListener("pointercancel", up);
});

$("previewHere").addEventListener("click", () => $("previewToast").click());

$("sweepNow").addEventListener("click", async () => {
  const n: number = await browser.runtime.sendMessage({ type: "sweepNow" });
  flash(n ? `Closed ${n} tab${n === 1 ? "" : "s"}` : "Nothing to close");
});

// ---------- Snoozed ----------

async function renderSnoozed(): Promise<void> {
  const items = (await getSnoozed()).sort((a, b) => a.wakeAt - b.wakeAt);
  $("snoozed").replaceChildren(
    ...items.map((s) =>
      tr({
        icon: fav(s.favIconUrl, hostOf(s.url)),
        url: s.url,
        title: s.title,
        sub: bareHost(s.url),
        num: when(s.wakeAt),
        numTitle: `Reopens ${fmtDateTime(s.wakeAt)}`,
        actions: [
          act("Open now", () => browser.runtime.sendMessage({ type: "wake", id: s.id })),
          act("Delete", () => browser.runtime.sendMessage({ type: "cancel", id: s.id }), true),
        ],
      }),
    ),
  );
  $("snoozedEmpty").hidden = items.length > 0;
  $("snoozedCount").textContent = items.length ? String(items.length) : "";
}

// ---------- Auto-closed: sweeps, then sites ----------

const openGroups = new Set<string>();

/** Reopen the given entries and drop them from the log. */
async function reopen(entries: ClosedTab[]): Promise<void> {
  for (const c of entries) await browser.tabs.create({ url: c.url, active: false }).catch(() => {});
  const gone = new Set(entries.map((c) => `${c.closedAt}|${c.url}`));
  const all = await getClosed();
  await browser.storage.local.set({ closed: all.filter((c) => !gone.has(`${c.closedAt}|${c.url}`)) });
}

/** Group newest-first entries into sweeps (same batch id, or closed within a minute for older data). */
function groupSweeps(items: ClosedTab[]): ClosedTab[][] {
  const sweeps: ClosedTab[][] = [];
  for (const c of items) {
    const cur = sweeps.at(-1);
    const prev = cur?.at(-1);
    const same =
      prev && (c.batch != null && prev.batch != null ? c.batch === prev.batch : Math.abs(prev.closedAt - c.closedAt) < 60_000);
    if (same) cur!.push(c);
    else sweeps.push([c]);
  }
  return sweeps;
}

function tabRow(c: ClosedTab, sub: string): HTMLDivElement {
  return tr({
    icon: fav(c.favIconUrl, hostOf(c.url)),
    url: c.url,
    title: c.title,
    sub,
    actions: [act("Reopen", () => reopen([c]))],
  });
}

function siteGroup(key: string, host: string, tabs: ClosedTab[]): HTMLDivElement {
  const open = openGroups.has(key);
  const group = el("div", "domain" + (open ? " open" : ""));
  const chev = el("span", "chev");
  chev.append(iconNode(ChevronRight, 16));
  const head = tr({
    lead: chev,
    icon: fav(tabs.find((t) => t.favIconUrl)?.favIconUrl, host),
    title: host,
    titleClass: "name",
    num: `${tabs.length} tabs`,
    actions: [act("Reopen all", () => reopen(tabs))],
  });
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", String(open));
  head.tabIndex = 0;
  const toggle = () => {
    const now = group.classList.toggle("open");
    head.setAttribute("aria-expanded", String(now));
    if (now) openGroups.add(key);
    else openGroups.delete(key);
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.target === head && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle();
    }
  });
  const kids = el("div", "kids");
  kids.append(...tabs.map((t) => tabRow(t, pathOf(t.url))));
  group.append(head, kids);
  return group;
}

async function renderClosed(): Promise<void> {
  const items = await getClosed();
  const frag = document.createDocumentFragment();

  for (const sweep of groupSweeps(items)) {
    const key = String(sweep[0].batch ?? sweep[0].closedAt);
    const byHost = new Map<string, ClosedTab[]>();
    for (const c of sweep) {
      const h = bareHost(c.url) || "Other";
      byHost.set(h, [...(byHost.get(h) ?? []), c]);
    }
    const sites = [...byHost].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const n = sweep.length;

    const sec = el("div", "sweep");
    const head = el("div", "sweep-head");
    head.append(
      el("span", "", `${when(sweep[0].closedAt)} · ${n} tab${n === 1 ? "" : "s"} from ${sites.length} site${sites.length === 1 ? "" : "s"}`),
      el("span", "grow"),
      act("Reopen all", () => reopen(sweep)),
    );
    const table = el("div", "table");
    for (const [host, tabs] of sites) {
      table.append(tabs.length === 1 ? tabRow(tabs[0], host) : siteGroup(`${key}|${host}`, host, tabs));
    }
    sec.append(head, table);
    frag.append(sec);
  }

  $("closed").replaceChildren(frag);
  $("closedEmpty").hidden = items.length > 0;
  $("clearClosed").hidden = items.length === 0;
  $("closedCount").textContent = items.length ? String(items.length) : "";
}

$("clearClosed").addEventListener("click", async () => {
  if (!confirm("Clear the whole auto-closed history?")) return;
  await browser.storage.local.set({ closed: [] });
});

// ---------- Init ----------

browser.storage.onChanged.addListener((changes) => {
  if (changes.snoozed) renderSnoozed();
  if (changes.closed) renderClosed();
  if (changes.favicons) favicons = (changes.favicons.newValue as Record<string, string>) ?? {};
});

(async () => {
  const s = await getSettings();
  favicons = await getFavicons();
  days.value = String(s.days);
  skipPinned.checked = s.skipPinned;
  skipAudible.checked = s.skipAudible;
  // Toast only works if the permission is still granted.
  toast.checked = s.toast && (await browser.permissions.contains({ origins: ["<all_urls>"] }));
  whitelist = [...s.whitelist];
  place = { x: s.toastX, y: s.toastY };
  renderPlace();
  renderChips();
  renderSnoozed();
  renderClosed();
})();
