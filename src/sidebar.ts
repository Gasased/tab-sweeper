import {
  getSettings,
  getSnoozed,
  getClosed,
  isProtected,
  fmtDateTime,
  fmtRelative,
  DAY_MS,
  usableIcon,
} from "./shared";
import { iconNode, Globe } from "./icons";

const $ = (id: string) => document.getElementById(id)!;
const SOON_LIMIT = 15;
const CLOSED_LIMIT = 30;

function item(opts: {
  title: string;
  favIconUrl?: string;
  meta: string;
  metaTitle?: string;
  warn?: boolean;
  onClick: () => void;
  actions?: [string, () => void][];
}): HTMLLIElement {
  const li = document.createElement("li");
  const img = document.createElement("span");
  img.className = "fav";
  const globe = () => img.replaceChildren(iconNode(Globe, 16));
  const src = usableIcon(opts.favIconUrl);
  if (src) {
    const i = document.createElement("img");
    i.alt = "";
    i.src = src;
    i.onerror = globe;
    img.append(i);
  } else globe();
  const info = document.createElement("div");
  info.className = "info";
  const t = document.createElement("span");
  t.className = "title";
  t.textContent = opts.title;
  t.title = opts.title;
  const m = document.createElement("span");
  m.className = "meta" + (opts.warn ? " warn" : "");
  m.textContent = opts.meta;
  if (opts.metaTitle) m.title = opts.metaTitle;
  info.append(t, m);
  const actions = document.createElement("div");
  actions.className = "actions";
  for (const [label, fn] of opts.actions ?? []) {
    const b = document.createElement("button");
    b.className = "link";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    actions.append(b);
  }
  li.append(img, info, actions);
  li.addEventListener("click", opts.onClick);
  return li;
}

function setCount(id: string, n: number): void {
  $(id).textContent = n ? String(n) : "";
}

async function renderSnoozed(): Promise<void> {
  const items = (await getSnoozed()).sort((a, b) => a.wakeAt - b.wakeAt);
  $("snoozed").replaceChildren(
    ...items.map((s) =>
      item({
        title: s.title || s.url,
        favIconUrl: s.favIconUrl,
        meta: `Reopens ${fmtRelative(s.wakeAt)}`,
        metaTitle: fmtDateTime(s.wakeAt),
        onClick: () => browser.runtime.sendMessage({ type: "wake", id: s.id }),
        actions: [
          ["Open", () => browser.runtime.sendMessage({ type: "wake", id: s.id })],
          ["Delete", () => browser.runtime.sendMessage({ type: "cancel", id: s.id })],
        ],
      }),
    ),
  );
  $("snoozedEmpty").hidden = items.length > 0;
  setCount("snoozedCount", items.length);
}

async function renderSoon(): Promise<void> {
  const settings = await getSettings();
  const empty = $("soonEmpty");
  if (!settings.days || settings.days <= 0) {
    $("soon").replaceChildren();
    empty.textContent = "Auto-close is off.";
    setCount("soonCount", 0);
    return;
  }
  const tabs = (await browser.tabs.query({}))
    .filter((t) => t.lastAccessed && !isProtected(t, settings))
    .map((t) => ({ t, closeAt: t.lastAccessed! + settings.days * DAY_MS }))
    .sort((a, b) => a.closeAt - b.closeAt);
  $("soon").replaceChildren(
    ...tabs.slice(0, SOON_LIMIT).map(({ t, closeAt }) =>
      item({
        title: t.title || t.url || "",
        favIconUrl: t.favIconUrl,
        meta: closeAt <= Date.now() ? "Closing at next check" : `Closes ${fmtRelative(closeAt)}`,
        metaTitle: `Last visited ${fmtDateTime(t.lastAccessed!)}`,
        warn: closeAt - Date.now() < DAY_MS,
        onClick: () => {
          browser.tabs.update(t.id!, { active: true });
          browser.windows.update(t.windowId!, { focused: true });
        },
      }),
    ),
  );
  empty.textContent = tabs.length ? "" : "No tabs will be closed.";
  setCount("soonCount", tabs.length);
}

async function renderClosed(): Promise<void> {
  const items = await getClosed();
  $("closed").replaceChildren(
    ...items.slice(0, CLOSED_LIMIT).map((c, i) => {
      const reopen = async () => {
        await browser.tabs.create({ url: c.url, active: true }).catch(() => {});
        const all = await getClosed();
        all.splice(i, 1);
        await browser.storage.local.set({ closed: all });
      };
      return item({
        title: c.title || c.url,
        favIconUrl: c.favIconUrl,
        meta: `Closed ${fmtRelative(c.closedAt)}`,
        metaTitle: fmtDateTime(c.closedAt),
        onClick: reopen,
        actions: [["Reopen", reopen]],
      });
    }),
  );
  $("closedEmpty").hidden = items.length > 0;
  setCount("closedCount", items.length);
}

// ---------- Live updates ----------

let soonTimer: number | undefined;
function scheduleSoon(): void {
  clearTimeout(soonTimer);
  soonTimer = window.setTimeout(renderSoon, 300);
}

browser.storage.onChanged.addListener((changes) => {
  if (changes.snoozed) renderSnoozed();
  if (changes.closed) renderClosed();
  if (changes.settings) renderSoon();
});
browser.tabs.onActivated.addListener(scheduleSoon);
browser.tabs.onCreated.addListener(scheduleSoon);
browser.tabs.onRemoved.addListener(scheduleSoon);
browser.tabs.onUpdated.addListener(scheduleSoon, { properties: ["title", "pinned", "audible", "favIconUrl"] });

// Refresh relative times every minute.
setInterval(() => {
  renderSnoozed();
  renderSoon();
  renderClosed();
}, 60_000);

$("settings").addEventListener("click", () => browser.runtime.openOptionsPage());
$("snoozeCurrent").addEventListener("click", () => browser.action.openPopup());

renderSnoozed();
renderSoon();
renderClosed();
