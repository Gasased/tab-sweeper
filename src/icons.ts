// Lucide icons (https://lucide.dev) as SVG strings, resized for inline use.
export {
  Globe,
  ChevronRight,
  RotateCcw,
  Trash2,
  ExternalLink,
  X,
  Check,
} from "lucide-static";

export function icon(svg: string, size = 16): string {
  return svg
    .replace(/<!--.*?-->\s*/s, "")
    .replace('width="24"', `width="${size}"`)
    .replace('height="24"', `height="${size}"`)
    .replace("<svg", '<svg aria-hidden="true"')
    .replace('stroke-width="2"', 'stroke-width="1.5"');
}

/** Parse an icon into a real DOM node (avoids innerHTML). */
export function iconNode(svg: string, size = 16): SVGElement {
  const doc = new DOMParser().parseFromString(icon(svg, size), "image/svg+xml");
  return document.importNode(doc.documentElement, true) as unknown as SVGElement;
}

export function iconEl(svg: string, size = 16, className = "ico"): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.append(iconNode(svg, size));
  return span;
}
