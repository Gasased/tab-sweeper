import { fmtDateTime, usableIcon } from "./shared";
import { iconNode, Globe } from "./icons";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dateIn = $<HTMLInputElement>("date");
const timeIn = $<HTMLInputElement>("time");
const amountIn = $<HTMLInputElement>("amount");
const unitIn = $<HTMLSelectElement>("unit");
const preview = $("preview");

let mode: "date" | "duration" = "date";
let tabId: number | undefined;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Default: tomorrow at 9:00.
const def = new Date();
def.setDate(def.getDate() + 1);
def.setHours(9, 0, 0, 0);
dateIn.value = ymd(def);
dateIn.min = ymd(new Date());
timeIn.value = "09:00";

function wakeAt(): number {
  if (mode === "duration") {
    const n = Number(amountIn.value);
    return n > 0 ? Date.now() + n * Number(unitIn.value) : NaN;
  }
  if (!dateIn.value || !timeIn.value) return NaN;
  return new Date(`${dateIn.value}T${timeIn.value}`).getTime();
}

function updatePreview(): boolean {
  const t = wakeAt();
  const ok = !Number.isNaN(t) && t > Date.now();
  preview.textContent = ok ? `Reopens ${fmtDateTime(t)}` : "Pick a time in the future.";
  preview.classList.toggle("err", !ok);
  return ok;
}

for (const el of [dateIn, timeIn, amountIn, unitIn]) el.addEventListener("input", updatePreview);

document.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode as typeof mode;
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    $("paneDate").hidden = mode !== "date";
    $("paneDuration").hidden = mode !== "duration";
    (mode === "date" ? dateIn : amountIn).focus();
    updatePreview();
  }),
);

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!updatePreview() || tabId === undefined) return;
  await browser.runtime.sendMessage({ type: "snooze", tabId, wakeAt: wakeAt() });
  window.close();
});
$("close").addEventListener("click", () => window.close());
$("cancel").addEventListener("click", () => window.close());
$("settings").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

async function init(): Promise<void> {
  // Tab chosen via right-click menu, else the active tab in this window.
  const fromMenu: number | null = await browser.runtime.sendMessage({ type: "takeCustomTarget" });
  const tab = fromMenu != null
    ? await browser.tabs.get(fromMenu).catch(() => undefined)
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  tabId = tab?.id;
  const slot = $("tIcon");
  const globe = () => slot.replaceChildren(iconNode(Globe, 16));
  const src = usableIcon(tab?.favIconUrl);
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = src;
    img.onerror = globe;
    slot.replaceChildren(img);
  } else globe();
  $("tTitle").textContent = tab?.title ?? tab?.url ?? "";
  updatePreview();
  dateIn.focus();
}

init();
