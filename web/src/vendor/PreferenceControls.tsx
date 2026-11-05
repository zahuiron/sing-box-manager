// Portions from sing-box-dashboard@3e4bf08 (GPL-3.0-or-later); modified 2026-11-05. See web/THIRD_PARTY.md.
import {
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { Icon, useUI } from "../ui";
import {
  ACCENT_PRESETS,
  isAccentPreset,
  normalizeAccentColor,
  type AccentPreference,
  type AccentPreset,
  type ThemePreference,
} from "../theme";
import { useDismiss, useMenuPopover } from "./uiHooks";

const messages = {
  System: "跟随系统",
  Light: "浅色",
  Dark: "深色",
  Default: "默认",
  Blue: "蓝色",
  Purple: "紫色",
  Pink: "粉色",
  Red: "红色",
  Orange: "橙色",
  Yellow: "黄色",
  Green: "绿色",
  Graphite: "石墨色",
  "Custom color": "自定义颜色",
} as const;
type MessageKey = keyof typeof messages;
function useI18n() {
  const { t } = useUI();
  return { t: (key: MessageKey) => t(messages[key], key) };
}
function cx(...values: (string | false | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

export function Button(props: {
  children?: ReactNode;
  variant?: "primary" | "danger";
  size?: "small";
  className?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  href?: string;
  target?: string;
  rel?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  onClick?: MouseEventHandler;
  style?: CSSProperties;
}) {
  const className = cx("button", props.variant, props.size, props.className);
  if (props.href !== undefined) {
    return (
      <a
        className={className}
        href={props.href}
        target={props.target}
        rel={props.rel}
        title={props.title}
        aria-label={props["aria-label"]}
        style={props.style}
        onClick={props.onClick}
      >
        {props.children}
      </a>
    );
  }
  return (
    <button
      className={className}
      type={props.type ?? "button"}
      disabled={props.disabled}
      title={props.title}
      aria-label={props["aria-label"]}
      aria-expanded={props["aria-expanded"]}
      style={props.style}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function ThemeSelect(props: {
  theme: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="icon-segmented">
      {(
        [
          { value: "auto", icon: "brightness_auto", title: t("System") },
          { value: "light", icon: "light_mode", title: t("Light") },
          { value: "dark", icon: "dark_mode", title: t("Dark") },
        ] as const
      ).map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-label={option.title}
          className={props.theme === option.value ? "active" : ""}
          onClick={() => props.onChange(option.value)}
        >
          <Icon name={option.icon} size={15} />
        </button>
      ))}
    </div>
  );
}

const ACCENT_TITLES: Record<AccentPreset, MessageKey> = {
  default: "Default",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  graphite: "Graphite",
};

function AccentSelect(props: {
  accent: AccentPreference;
  onChange: (accent: AccentPreference) => void;
}) {
  const { t } = useI18n();
  const custom = isAccentPreset(props.accent) ? null : props.accent;
  const wellValue =
    custom ??
    (getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim() ||
      "#1a1a1a");
  return (
    <div className="accent-picker">
      {ACCENT_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          title={t(ACCENT_TITLES[preset])}
          aria-label={t(ACCENT_TITLES[preset])}
          aria-pressed={props.accent === preset}
          className={props.accent === preset ? "active" : ""}
          data-accent={preset}
          onClick={() => props.onChange(preset)}
        />
      ))}
      <label
        className={custom !== null ? "custom active" : "custom"}
        title={t("Custom color")}
      >
        <input
          type="color"
          value={wellValue}
          aria-label={t("Custom color")}
          onChange={(event) =>
            props.onChange(
              normalizeAccentColor(event.target.value) ?? event.target.value,
            )
          }
        />
      </label>
    </div>
  );
}

export function ThemeMenu(props: {
  accent: AccentPreference;
  onChange: (accent: AccentPreference) => void;
  openUp?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  return (
    <div className="menu-anchor" ref={ref}>
      <Button aria-expanded={open} onClick={() => setOpen(!open)}>
        {isAccentPreset(props.accent) ? (
          <>
            <span className="accent-dot" data-accent={props.accent} />
            {t(ACCENT_TITLES[props.accent])}
          </>
        ) : (
          <>
            <span className="accent-dot" style={{ background: props.accent }} />
            {props.accent.toUpperCase()}
          </>
        )}
        <Icon name="unfold_more" size={13} />
      </Button>
      {open && (
        <div
          className={
            props.openUp
              ? "menu open-up align-right accent-menu"
              : "menu align-right accent-menu"
          }
        >
          <AccentSelect
            accent={props.accent}
            onChange={(accent) => {
              props.onChange(accent);
              if (isAccentPreset(accent)) {
                setOpen(false);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

export function Select<T extends string | number>(props: {
  id?: string;
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  inline?: boolean;
  placeholder?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  useMenuPopover(ref, listRef, open, () => setOpen(false), {
    width: props.inline ? "min-anchor" : "anchor",
  });

  const selected = props.options.find((option) => option.value === props.value);

  const select = (value: T) => {
    setOpen(false);
    if (value !== props.value) {
      props.onChange(value);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      current === -1
        ? event.key === "ArrowDown"
          ? 0
          : items.length - 1
        : current + (event.key === "ArrowDown" ? 1 : -1);
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div
      className={
        props.inline
          ? "menu-anchor select-anchor inline"
          : "menu-anchor select-anchor"
      }
      ref={ref}
      onKeyDown={onKeyDown}
    >
      <button
        id={props.id}
        type="button"
        className={props.inline ? "select inline" : "select"}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
      >
        <span
          className={
            selected ? "select-value" : "select-value select-placeholder"
          }
        >
          {selected ? selected.label : props.placeholder}
        </span>
      </button>
      {open && (
        <div
          popover="manual"
          className={
            props.inline
              ? "menu popover-menu select-menu grow"
              : "menu popover-menu select-menu"
          }
          role="listbox"
          ref={listRef}
        >
          {props.options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              className="menu-item"
              onClick={() => select(option.value)}
            >
              <span className="menu-check">
                {option.value === props.value && (
                  <Icon name="check" size={13} />
                )}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
