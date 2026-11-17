import {
  PRESETS,
  type PresetId,
  type SnoozedTab,
  type ClosedTab,
  getSettings,
  getSnoozed,
  getClosed,
  presetTime,
  presetHint,
  isProtected,
  DAY_MS,
  hostOf,
  getFavicons,
  usableIcon,
  type ToastItem,
  type ToastPlace,
} from "./shared";

const SWEEP_ALARM = "sweep";
const SNOOZE_PREFIX = "snooze:";
const MAX_CLOSED_LOG = 200;

// ---------- Context menu ----------

const ROOT = "snooze-root";
const CUSTOM = "snooze-custom";

function createMenus(): void {
  browser.menus.removeAll().then(() => {
    browser.menus.create({ id: ROOT, title: "Snooze tab", contexts: ["tab", "page"] });
    for (const p of PRESETS) {
      browser.menus.create({ id: `preset:${p.id}`, parentId: ROOT, title: p.label, contexts: ["tab", "page"] });
    }
    browser.menus.create({ id: "sep", parentId: ROOT, type: "separator", contexts: ["tab", "page"] });
    browser.menus.create({ id: CUSTOM, parentId: ROOT, title: "Custom…", contexts: ["tab", "page"] });
  });
}

// Refresh labels with the actual target time every time the menu opens,
// e.g. "In 1 hour   (1:20)", and hide "This evening" once it's past 18:00.
browser.menus.onShown.addListener(async (info) => {
  if (!info.menuIds.includes(ROOT)) return;
  const now = new Date();
  for (const p of PRESETS) {
    const t = presetTime(p.id, now);
    await browser.menus.update(`preset:${p.id}`, {
      visible: t !== null,
      title: t ? `${p.label}  —  ${presetHint(p.id, t)}` : p.label,
    });
  }
  await browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const id = String(info.menuItemId);
  if (id.startsWith("preset:")) {
    const t = presetTime(id.slice("preset:".length) as PresetId);
    if (t) await snoozeTab(tab, t.getTime());
  } else if (id === CUSTOM) {
    // Open the toolbar popup. Must run synchronously inside the click handler
    // (before any await) so Firefox still treats it as a user action.
    customTarget = { tabId: tab.id, at: Date.now() };
    browser.action.openPopup().catch(() => {
      customTarget = null;
    });
  }
});

/** Tab picked via "Custom…" in the context menu, handed to the popup when it opens. */
let customTarget: { tabId: number; at: number } | null = null;

// ---------- Snooze ----------

async function snoozeTab(tab: browser.tabs.Tab, wakeAt: number): Promise<void> {
  if (!tab.id || !tab.url) return;
  const entry: SnoozedTab = {
    id: crypto.randomUUID(),
    url: tab.url,
    title: tab.title ?? tab.url,
    favIconUrl: usableIcon(tab.favIconUrl) ?? (await getFavicons())[hostOf(tab.url)],
    cookieStoreId: tab.cookieStoreId,
    wakeAt,
    snoozedAt: Date.now(),
  };
  const snoozed = await getSnoozed();
  snoozed.push(entry);
  await browser.storage.local.set({ snoozed });
  browser.alarms.create(SNOOZE_PREFIX + entry.id, { when: wakeAt });
  await browser.tabs.remove(tab.id);
}

async function wake(ids: string[] | "due"): Promise<void> {
  const snoozed = await getSnoozed();
  const now = Date.now();
  const toWake = snoozed.filter((s) => (ids === "due" ? s.wakeAt <= now : ids.includes(s.id)));
  if (toWake.length === 0) return;
  const remaining = snoozed.filter((s) => !toWake.includes(s));
  await browser.storage.local.set({ snoozed: remaining });
  for (const s of toWake) {
    browser.alarms.clear(SNOOZE_PREFIX + s.id);
    try {
      await browser.tabs.create({ url: s.url, active: false, cookieStoreId: s.cookieStoreId });
    } catch {
      // Container may be gone, or URL privileged — retry plainly.
      await browser.tabs.create({ url: s.url, active: false }).catch(() => {});
    }
  }
}

async function cancelSnooze(id: string): Promise<void> {
  const snoozed = await getSnoozed();
  await browser.storage.local.set({ snoozed: snoozed.filter((s) => s.id !== id) });
  await browser.alarms.clear(SNOOZE_PREFIX + id);
}

/** Make sure every stored snooze has an alarm (alarms don't survive browser restarts reliably). */
async function restoreSnoozeAlarms(): Promise<void> {
  await wake("due");
  for (const s of await getSnoozed()) {
    browser.alarms.create(SNOOZE_PREFIX + s.id, { when: s.wakeAt });
  }
}

// ---------- Auto-close sweep ----------

async function sweep(): Promise<number> {
  const settings = await getSettings();
  if (!settings.days || settings.days <= 0) return 0;
  const cutoff = Date.now() - settings.days * DAY_MS;
  const tabs = await browser.tabs.query({});
  const victims = tabs.filter((t) => {
    if (isProtected(t, settings)) return false;
    return !!t.lastAccessed && t.lastAccessed <= cutoff;
  });
  if (victims.length === 0) return 0;

  const batch = Date.now();
  const icons = await getFavicons();
  const log: ClosedTab[] = victims.map((t) => ({
    url: t.url ?? "",
    title: t.title ?? t.url ?? "",
    favIconUrl: usableIcon(t.favIconUrl) ?? icons[hostOf(t.url)],
    closedAt: batch,
    batch,
  }));
  const closed = [...log, ...(await getClosed())].slice(0, MAX_CLOSED_LOG);
  await browser.storage.local.set({ closed });
  await browser.tabs.remove(victims.map((t) => t.id!));
  if (settings.toast) {
    showToast(log.map((c) => ({ title: c.title, url: c.url, host: hostOf(c.url), favIconUrl: c.favIconUrl })));
  }
  return victims.length;
}

// ---------- Favicon cache ----------

let faviconWrite: Promise<void> = Promise.resolve();

browser.tabs.onUpdated.addListener(
  (_id, change, tab) => {
    const icon = usableIcon(change.favIconUrl);
    const host = hostOf(tab.url);
    if (!icon || !host) return;
    // Serialise writes so concurrent updates don't clobber each other.
    faviconWrite = faviconWrite.then(async () => {
      const favicons = await getFavicons();
      if (favicons[host] === icon) return;
      favicons[host] = icon;
      await browser.storage.local.set({ favicons });
    }).catch(() => {});
  },
  { properties: ["favIconUrl"] },
);

// ---------- On-page toast ----------

/** Inline a favicon as a data: URL (the toast's dust snapshot can't read cross-origin images). */
async function toDataUrl(url: string | undefined): Promise<string | undefined> {
  if (!url || url.startsWith("data:")) return url;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => resolve(undefined);
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

async function showToast(items: ToastItem[]): Promise<boolean> {
  if (!(await browser.permissions.contains({ origins: ["<all_urls>"] }))) return false;
  // Only the first few are shown as toasts; the rest are summarised.
  items = await Promise.all(
    items.map(async (it, i): Promise<ToastItem> => (i < 4 ? { ...it, favIconUrl: await toDataUrl(it.favIconUrl) } : it)),
  );
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return false;
  const settings = await getSettings();
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["toast.js"] });
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: (data: ToastItem[], place: ToastPlace) => (window as any).__tabSweeperToast?.(data, place),
      args: [items, { x: settings.toastX, y: settings.toastY }],
    });
    return true;
  } catch {
    return false; // about: pages, addons.mozilla.org, etc. can't be scripted.
  }
}

// ---------- Wiring ----------

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) sweep();
  else if (alarm.name.startsWith(SNOOZE_PREFIX)) wake([alarm.name.slice(SNOOZE_PREFIX.length)]);
});

type Message =
  | { type: "snooze"; tabId: number; wakeAt: number }
  | { type: "wake"; id: string }
  | { type: "cancel"; id: string }
  | { type: "sweepNow" }
  | { type: "takeCustomTarget" }
  | { type: "previewToast" }
  | { type: "undoClose"; url: string };

browser.runtime.onMessage.addListener(async (msg: Message) => {
  switch (msg.type) {
    case "snooze": {
      const tab = await browser.tabs.get(msg.tabId);
      await snoozeTab(tab, msg.wakeAt);
      return true;
    }
    case "wake":
      await wake([msg.id]);
      return true;
    case "cancel":
      await cancelSnooze(msg.id);
      return true;
    case "sweepNow":
      return sweep();
    case "undoClose": {
      await browser.tabs.create({ url: msg.url, active: false }).catch(() => {});
      const closed = await getClosed();
      const i = closed.findIndex((c) => c.url === msg.url);
      if (i >= 0) {
        closed.splice(i, 1);
        await browser.storage.local.set({ closed });
      }
      return true;
    }
    case "previewToast": {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      return showToast([
        { title: tab?.title || "Example tab", host: hostOf(tab?.url) || "example.com", favIconUrl: usableIcon(tab?.favIconUrl) },
        { title: "Another tab you forgot about", host: "news.ycombinator.com" },
      ]);
    }
    case "takeCustomTarget": {
      const t = customTarget && Date.now() - customTarget.at < 15_000 ? customTarget.tabId : null;
      customTarget = null;
      return t;
    }
  }
});

function init(): void {
  createMenus();
  browser.alarms.create(SWEEP_ALARM, { delayInMinutes: 1, periodInMinutes: 30 });
  restoreSnoozeAlarms();
}

browser.runtime.onInstalled.addListener(init);
browser.runtime.onStartup.addListener(init);
