// Injected into the active page when tabs are auto-closed. Shows a stack of
// toasts in a closed shadow root, then disintegrates each one into dust.
import { Globe, iconNode } from "./icons";
import { placeStyle, type ToastItem, type ToastPlace } from "./shared";
import { dissolve } from "./dust";

type Win = Window & { __tabSweeperToast?: (items: ToastItem[], place?: ToastPlace) => void };
const w = window as Win;

const MAX_VISIBLE = 4;
const HOLD_MS = 4200;
const W = 340;
const H = 56;
// Same tokens as the extension pages (dark). Hex because the canvas replica needs real colors.
const C = {
  bg: "#1c1c1b", // card, hsl(30 2% 11%)
  border: "#2a2928", // border, 16%
  raised: "#272726", // raised, 15%
  fg: "#f0f0ef", // text 1
  muted: "#8f8e8d", // text 3
  accent: "#e39b78", // clay accent text
};
const FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`;

export const CSS = `
:host { all: initial; }
.stack { position: fixed; inset: auto 16px 16px auto; z-index: 2147483647; display: flex; flex-direction: column-reverse; gap: 8px; pointer-events: none; font-family: ${FONT}; }
.toast { position: relative; width: ${W}px; height: ${H}px; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 0 8px 0 16px;
  background: ${C.bg}; border: 1px solid ${C.border}; border-radius: 12px; color: ${C.fg};
  box-shadow: 0 4px 16px rgb(0 0 0 / .35); pointer-events: auto;
  --from: 8px; animation: in .24s cubic-bezier(.2,.8,.2,1) both; }
.toast.gone { visibility: hidden; }
.toast.collapse { height: 0; margin-top: -8px; border-width: 0; transition: height .35s cubic-bezier(.2,.8,.2,1), margin .35s cubic-bezier(.2,.8,.2,1); }
.stack.down .toast.collapse { margin-top: 0; margin-bottom: -8px; }
@keyframes in { from { opacity: 0; transform: translateY(var(--from)); } }
.stack.down .toast { --from: -8px; }
.icon { flex: none; width: 16px; height: 16px; display: grid; place-items: center; color: ${C.muted}; }
.icon img { width: 16px; height: 16px; border-radius: 3px; }
.text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.label { font-size: 12px; color: ${C.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { all: unset; cursor: pointer; font-size: 13px; font-weight: 500; color: ${C.accent}; height: 28px; line-height: 28px; padding: 0 8px; border-radius: 6px; }
button:hover { background: ${C.raised}; }
button:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
`;

let root: ShadowRoot | null = null;
let stack: HTMLDivElement;

function ensureRoot(): void {
  if (root?.host.isConnected) return;
  const host = document.createElement("tab-sweeper-toast");
  root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  stack = document.createElement("div");
  stack.className = "stack";
  root.append(style, stack);
  document.documentElement.append(host);
}

export function makeToast(item: ToastItem, label: string, undo?: () => void): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "toast";
  const icon = document.createElement("div");
  icon.className = "icon";
  const globe = () => icon.replaceChildren(iconNode(Globe, 16));
  if (item.favIconUrl) {
    const img = document.createElement("img");
    img.src = item.favIconUrl;
    img.onerror = globe;
    icon.append(img);
  } else globe();
  const text = document.createElement("div");
  text.className = "text";
  const l = document.createElement("span");
  l.className = "label";
  l.textContent = label;
  const t = document.createElement("span");
  t.className = "title";
  t.textContent = item.title;
  text.append(l, t);
  el.append(icon, text);
  if (undo) {
    const b = document.createElement("button");
    b.textContent = "Undo";
    b.addEventListener("click", () => {
      undo();
      dissolveToast(el);
    });
    el.append(b);
  }
  return el;
}

// ---------- Dust (Telegram-style, see dust.ts) ----------

const SHADOW = { blur: 16, y: 4, color: "rgb(0 0 0 / .35)" };
export const MARGIN = 20; // snapshot covers the shadow too, so it turns to dust with the rest

// Lucide "globe" (https://lucide.dev), drawn as paths so the canvas stays untainted.
const GLOBE = ["M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"];

function fitText(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max + 0.5) return s;
  while (s.length && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}

/** Draw one text element exactly where the DOM laid it out (same font, baseline and ellipsis). */
function paintText(ctx: CanvasRenderingContext2D, el: HTMLElement): void {
  const node = el.firstChild;
  if (!node || !node.textContent) return;
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.fillStyle = cs.color;
  ctx.textBaseline = "alphabetic";
  const range = document.createRange();
  range.selectNodeContents(el);
  const line = range.getClientRects()[0];
  const box = el.getBoundingClientRect();
  const left = box.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
  const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const m = ctx.measureText(node.textContent);
  const top = line ? line.top : box.top;
  const lineH = line ? line.height : box.height;
  const contentH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const baseline = top + (lineH - contentH) / 2 + m.fontBoundingBoxAscent;
  ctx.fillText(fitText(ctx, node.textContent, width), left, baseline);
}

/** Paint the toast into `ctx` (CSS px, origin at its top-left minus MARGIN). */
export function paintToast(ctx: CanvasRenderingContext2D, el: HTMLElement): void {
  const box = el.getBoundingClientRect();
  ctx.translate(MARGIN - box.left, MARGIN - box.top);
  const cs = getComputedStyle(el);
  const radius = parseFloat(cs.borderTopLeftRadius) || 0;

  ctx.save();
  ctx.shadowColor = SHADOW.color;
  ctx.shadowBlur = SHADOW.blur;
  ctx.shadowOffsetY = SHADOW.y;
  ctx.beginPath();
  ctx.roundRect(box.left, box.top, box.width, box.height, radius);
  ctx.fillStyle = cs.backgroundColor;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.roundRect(box.left + 0.5, box.top + 0.5, box.width - 1, box.height - 1, radius - 0.5);
  ctx.strokeStyle = cs.borderTopColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  const icon = el.querySelector<HTMLElement>(".icon");
  const img = icon?.querySelector("img");
  if (icon && img && img.complete && img.naturalWidth && img.src.startsWith("data:")) {
    const r = img.getBoundingClientRect();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.left, r.top, r.width, r.height, 3);
    ctx.clip();
    ctx.drawImage(img, r.left, r.top, r.width, r.height);
    ctx.restore();
  } else if (icon) {
    const r = icon.getBoundingClientRect();
    ctx.save();
    ctx.translate(r.left, r.top);
    ctx.scale(r.width / 24, r.height / 24);
    ctx.strokeStyle = getComputedStyle(icon).color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.arc(12, 12, 10, 0, Math.PI * 2);
    ctx.stroke();
    for (const d of GLOBE) ctx.stroke(new Path2D(d));
    ctx.restore();
  }

  el.querySelectorAll<HTMLElement>(".label, .title, button").forEach((t) => paintText(ctx, t));
}

function dissolveToast(el: HTMLDivElement): void {
  if (el.dataset.gone) return;
  el.dataset.gone = "1";
  dissolve({
    rect: el.getBoundingClientRect(),
    margin: MARGIN,
    parent: root!,
    paint: (ctx) => paintToast(ctx, el),
    onTakeover: () => {
      el.classList.add("gone");
      // Close the gap in the stack once most of the toast has blown away.
      setTimeout(() => el.classList.add("collapse"), 450);
    },
    onDone: () => {
      el.remove();
      if (!stack.children.length) root?.host.remove();
    },
  });
}

// ---------- Entry ----------

if (!w.__tabSweeperToast) {
  w.__tabSweeperToast = (items: ToastItem[], place: ToastPlace = { x: 100, y: 100 }) => {
    ensureRoot();
    Object.assign(stack.style, placeStyle(place.x, place.y, 16));
    stack.classList.toggle("down", place.y < 50);
    const shown = items.length > MAX_VISIBLE ? items.slice(0, MAX_VISIBLE - 1) : items;
    const entries: { item: ToastItem; label: string; undo?: () => void }[] = shown.map((item) => ({
      item,
      label: `Closed · ${item.host || "tab"}`,
      undo: item.url ? () => browser.runtime.sendMessage({ type: "undoClose", url: item.url }) : undefined,
    }));
    if (items.length > shown.length) {
      entries.push({
        item: { title: `+${items.length - shown.length} more tabs closed`, host: "" },
        label: "Tab Sweeper",
      });
    }
    entries.forEach(({ item, label, undo }, i) => {
      setTimeout(() => {
        const el = makeToast(item, label, undo);
        stack.append(el);
        setTimeout(() => dissolveToast(el), HOLD_MS + i * 350);
      }, i * 120);
    });
  };
}
