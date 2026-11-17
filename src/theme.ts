// Loaded in <head> so the right theme is set before first paint. Follows the system setting.
const mq = matchMedia("(prefers-color-scheme: light)");
const apply = () => (document.documentElement.dataset.theme = mq.matches ? "light" : "dark");
apply();
mq.addEventListener("change", apply);
