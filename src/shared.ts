export interface Settings {
  /** Close tabs not visited for this many days. 0 disables auto-close. */
  days: number;
  skipPinned: boolean;
  skipAudible: boolean;
  /** Hostnames that are never auto-closed. */
  whitelist: string[];
  /** Show an on-page toast when tabs are auto-closed (needs optional host permission). */
  toast: boolean;
  /** Where the toast stack sits, as % of the window: 0 = left/top edge, 100 = right/bottom edge. */
  toastX: number;
  toastY: number;
}

export interface SnoozedTab {
  id: string;
  url: string;
  title: string;
  favIconUrl?: string;
  cookieStoreId?: string;
  wakeAt: number;
  snoozedAt: number;
}

export interface ClosedTab {
  url: string;
  title: string;
  favIconUrl?: string;
  closedAt: number;
  /** Id shared by all tabs closed in the same sweep. */
  batch?: number;
}

/** What the on-page toast shows for each closed tab. */
export interface ToastItem {
  title: string;
  url?: string;
  host: string;
  favIconUrl?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  days: 7,
  skipPinned: true,
  skipAudible: true,
  whitelist: [],
  toast: false,
  toastX: 100,
  toastY: 100,
};

/** Placement of the toast stack. */
export interface ToastPlace {
  x: number;
  y: number;
}

const COLS = ["left", "center", "right"];
const ROWS = ["Top", "Middle", "Bottom"];
/** "Bottom right", "Center", or null for a custom spot. */
export function placeName(x: number, y: number): string | null {
  const c = [0, 50, 100].indexOf(x), r = [0, 50, 100].indexOf(y);
  if (c < 0 || r < 0) return null;
  if (c === 1 && r === 1) return "Center";
  return `${ROWS[r]} ${COLS[c]}`;
}

/**
 * CSS for a fixed stack anchored at (x%, y%) of its container, kept `margin` px inside the edges.
 * Shared by the on-page toast and the settings preview, so the preview is exact.
 */
export function placeStyle(x: number, y: number, margin: number): Partial<CSSStyleDeclaration> {
  const fx = x / 100, fy = y / 100;
  return {
    left: `calc(${margin}px + (100% - ${margin * 2}px) * ${fx})`,
    top: `calc(${margin}px + (100% - ${margin * 2}px) * ${fy})`,
    right: "auto",
    bottom: "auto",
    transform: `translate(${-x}%, ${-y}%)`,
    // Newest toast lands nearest the edge it is anchored to.
    flexDirection: y < 50 ? "column" : "column-reverse",
  };
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function getSnoozed(): Promise<SnoozedTab[]> {
  const { snoozed } = await browser.storage.local.get("snoozed");
  return (snoozed as SnoozedTab[] | undefined) ?? [];
}

export async function getClosed(): Promise<ClosedTab[]> {
  const { closed } = await browser.storage.local.get("closed");
  return (closed as ClosedTab[] | undefined) ?? [];
}

// ---------- Snooze presets ----------

export type PresetId = "1h" | "3h" | "evening" | "tomorrow" | "nextweek";

export interface Preset {
  id: PresetId;
  label: string;
}

export const PRESETS: Preset[] = [
  { id: "1h", label: "In 1 hour" },
  { id: "3h", label: "In 3 hours" },
  { id: "evening", label: "This evening" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "nextweek", label: "Next week" },
];

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** Returns the wake time for a preset, or null if it is not available right now. */
export function presetTime(id: PresetId, now = new Date()): Date | null {
  const d = new Date(now);
  switch (id) {
    case "1h":
      return new Date(now.getTime() + 60 * 60 * 1000);
    case "3h":
      return new Date(now.getTime() + 3 * 60 * 60 * 1000);
    case "evening":
      d.setHours(EVENING_HOUR, 0, 0, 0);
      return d > now ? d : null;
    case "tomorrow":
      d.setDate(d.getDate() + 1);
      d.setHours(MORNING_HOUR, 0, 0, 0);
      return d;
    case "nextweek": {
      // Next Monday (always at least 1 day away).
      const daysUntilMon = ((8 - d.getDay()) % 7) || 7;
      d.setDate(d.getDate() + daysUntilMon);
      d.setHours(MORNING_HOUR, 0, 0, 0);
      return d;
    }
  }
}

export function fmtTime(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function presetHint(id: PresetId, d: Date): string {
  if (id === "nextweek") {
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${fmtTime(d)}`;
  }
  return fmtTime(d);
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------- Auto-close rules ----------

export const DAY_MS = 24 * 60 * 60 * 1000;

export function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

/** True if a tab must never be auto-closed, regardless of how long since it was visited. */
export function isProtected(t: browser.tabs.Tab, settings: Settings): boolean {
  if (t.active) return true;
  if (settings.skipPinned && t.pinned) return true;
  if (settings.skipAudible && t.audible) return true;
  const host = hostOf(t.url);
  return !!host && settings.whitelist.some((w) => host === w || host.endsWith("." + w));
}

/** "in 3h", "in 2d", "5m ago" — compact relative time. */
export function fmtRelative(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const v =
    abs < 3600000 ? `${Math.max(1, Math.round(abs / 60000))}m`
    : abs < DAY_MS ? `${Math.round(abs / 3600000)}h`
    : `${Math.round(abs / DAY_MS)}d`;
  return diff >= 0 ? `in ${v}` : `${v} ago`;
}

/** Last known favicon per hostname, so tabs that were never loaded still get an icon. */
export async function getFavicons(): Promise<Record<string, string>> {
  const { favicons } = await browser.storage.local.get("favicons");
  return (favicons as Record<string, string> | undefined) ?? {};
}

/** Favicons safe to render in extension pages (skip internal chrome:// icons). */
export function usableIcon(url: string | undefined): string | undefined {
  return url && !url.startsWith("chrome:") ? url : undefined;
}
