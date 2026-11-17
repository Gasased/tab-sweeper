import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const ICON_COLOR = "#cf8560"; // clay accent, hsl(20 55% 60%)

/** Load a Lucide icon (https://lucide.dev) from lucide-static, sized and stripped of its license comment. */
function lucide(name: string, size = 16, attrs = ""): string {
  const svg = readFileSync(`node_modules/lucide-static/icons/${name}.svg`, "utf8")
    .replace(/<!--.*?-->\s*/s, "")
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`)
    .replace(/<svg/, `<svg aria-hidden="true" ${attrs}`)
    .replace('stroke-width="2"', 'stroke-width="1.5"');
  return svg.replace(/\s*\n\s*/g, " ").trim();
}

rmSync("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/background.ts", "src/custom.ts", "src/options.ts", "src/sidebar.ts", "src/toast.ts", "src/theme.ts"],
  outdir: "dist",
  target: "browser",
  format: "iife",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
cpSync("static", "dist", { recursive: true });

// Inline <i data-lucide="name" data-size="16"></i> placeholders in HTML.
for (const f of readdirSync("dist").filter((f) => f.endsWith(".html"))) {
  const path = `dist/${f}`;
  const html = readFileSync(path, "utf8").replace(
    /<i data-lucide="([\w-]+)"(?: data-size="(\d+)")?><\/i>/g,
    (_, name: string, size?: string) => lucide(name, size ? Number(size) : 16),
  );
  writeFileSync(path, html);
}

// Extension / toolbar / sidebar icon: Lucide alarm-clock.
writeFileSync("dist/icon.svg", lucide("alarm-clock", 24).replace('stroke="currentColor"', `stroke="${ICON_COLOR}"`));

console.log("Built to dist/");
