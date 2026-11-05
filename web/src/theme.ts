// Portions from sing-box-dashboard@3e4bf08 (GPL-3.0-or-later); modified 2026-11-05. See web/THIRD_PARTY.md.
export type ThemePreference = "auto" | "light" | "dark";

export function applyTheme(preference: ThemePreference) {
  const dark =
    preference === "dark" ||
    (preference === "auto" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";

  const surface = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface")
    .trim();
  if (surface) {
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", surface);
    });
  }

  // iOS 26 Safari ignores theme-color and tints the status bar from the
  // .statusbar-tint probe (see globals.css). It only samples a fixed element
  // when a new node enters the render tree: color changes on a registered
  // element go unnoticed, and removals are dropped too (WebKit bug 300965).
  const tint = document.getElementById("statusbar-tint");
  if (tint) {
    const fresh = tint.cloneNode(true) as HTMLElement;
    tint.replaceWith(fresh);
    const flash = fresh.cloneNode(true) as HTMLElement;
    flash.removeAttribute("id");
    document.body.appendChild(flash);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        flash.remove();
      });
    });
  }
}

export const ACCENT_PRESETS = [
  "default",
  "blue",
  "purple",
  "pink",
  "red",
  "orange",
  "yellow",
  "green",
  "graphite",
] as const;

export type AccentPreset = (typeof ACCENT_PRESETS)[number];

export type AccentPreference = AccentPreset | (string & {});

export function isAccentPreset(value: string): value is AccentPreset {
  return (ACCENT_PRESETS as readonly string[]).includes(value);
}

export function normalizeAccentColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return `#${hex}`;
  }
  return null;
}

export function applyAccent(preference: AccentPreference) {
  const root = document.documentElement;
  if (isAccentPreset(preference)) {
    root.dataset.accent = preference;
    root.style.removeProperty("--custom-accent");
    root.style.removeProperty("--on-accent");
  } else {
    root.dataset.accent = "custom";
    root.style.setProperty("--custom-accent", preference);
    const channel = (index: number) => {
      const value =
        parseInt(preference.slice(1 + index * 2, 3 + index * 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance =
      0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    root.style.setProperty(
      "--on-accent",
      luminance > 0.45 ? "#1a1a1a" : "#ffffff",
    );
  }
}
