// Tiny DOM helpers. All dynamic text goes through textContent (never innerHTML).

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Stroke icons (24x24 viewBox), drawn to match the light mockup.
const ICONS = {
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4.2-4.2"],
  person: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"],
  needsMe: [
    "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
    "M3.5 19.5c0-3 2.9-5.4 6.5-5.4 1 0 1.9.2 2.7.5",
    "M17.5 13.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
    "M17.5 15.5v1.6l1 .9",
  ],
  play: ["M8 5.5v13l10.5-6.5z"],
  idle: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M8 12h8"],
  stuck: ["M12 4 2.8 19.5h18.4z", "M12 10v4.5", "M12 17.2v.1"],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronUp: ["M6 15l6-6 6 6"],
  chevronRight: ["M9 6l6 6-6 6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  bookmark: ["M7 4h10v16l-5-3.6L7 20z"],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
