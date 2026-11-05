// Portions from sing-box-dashboard@3e4bf08 (GPL-3.0-or-later); modified 2026-11-05. See web/THIRD_PARTY.md.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { ICON_PATHS as REFERENCE_ICON_PATHS } from "./vendor/iconPaths";
import {
  applyAccent,
  applyTheme,
  isAccentPreset,
  normalizeAccentColor,
  type ThemePreference,
} from "./theme";

const ICON_PATHS = {
  ...REFERENCE_ICON_PATHS,
  person:
    "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
} as const;

export type IconName = keyof typeof ICON_PATHS;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      style={{ width: size, height: size, flexShrink: 0 }}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
export function IconButton({
  icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
export function SecretInput({
  value,
  onChange,
  id,
  required = false,
  placeholder,
  autoComplete = "off",
  multiline = false,
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  multiline?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useUI();
  return (
    <div className="secret-input">
      {multiline ? (
        <textarea
          id={id}
          className="input ca-input"
          rows={visible ? 5 : 1}
          value={visible ? value : value ? "••••••••" : ""}
          readOnly={!visible}
          onFocus={() => setVisible(true)}
          onChange={(event) => {
            if (visible) onChange(event.target.value);
          }}
          aria-label={id}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck={false}
        />
      ) : (
        <input
          id={id}
          className="input"
          type={visible ? "text" : "password"}
          value={value}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck={false}
        />
      )}
      <IconButton
        icon={visible ? "visibility_off" : "visibility"}
        label={
          visible ? t("隐藏密钥", "Hide secret") : t("显示密钥", "Show secret")
        }
        onClick={() => setVisible(!visible)}
      />
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    element.showModal();
    const hide = () => {
      if (element.open) element.close();
    };
    const show = () => {
      if (!element.open && element.isConnected) element.showModal();
    };
    window.addEventListener("sbm:unauthorized", hide);
    window.addEventListener("sbm:authenticated", show);
    return () => {
      hide();
      window.removeEventListener("sbm:unauthorized", hide);
      window.removeEventListener("sbm:authenticated", show);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        if (
          e.target === e.currentTarget &&
          !busy &&
          (e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom)
        )
          onClose();
      }}
    >
      <h3>{title}</h3>
      {children}
    </dialog>
  );
}

interface Preferences {
  appearance: ThemePreference;
  accent: string;
  color: string;
  language: "auto" | "zh-CN" | "en";
}
const defaults: Preferences = {
  appearance: "auto",
  accent: "default",
  color: "#4a7ba6",
  language: "auto",
};
const UIContext = createContext({
  preferences: defaults,
  language: "zh-CN" as "zh-CN" | "en",
  update: (_: Partial<Preferences>) => {},
  t: (zh: string, _en: string) => zh,
});

export function UIProvider({ children }: { children: ReactNode }) {
  const detectLanguage = () =>
    navigator.language.toLowerCase().startsWith("zh")
      ? ("zh-CN" as const)
      : ("en" as const);
  const [systemLanguage, setSystemLanguage] = useState(detectLanguage);
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      return {
        ...defaults,
        ...JSON.parse(localStorage.getItem("sbm.preferences") || "{}"),
      };
    } catch {
      return defaults;
    }
  });
  const language =
    preferences.language === "auto" ? systemLanguage : preferences.language;
  useEffect(() => {
    const changed = () => setSystemLanguage(detectLanguage());
    window.addEventListener("languagechange", changed);
    return () => window.removeEventListener("languagechange", changed);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      applyTheme(preferences.appearance);
      applyAccent(
        preferences.accent === "custom"
          ? normalizeAccentColor(preferences.color) || defaults.color
          : isAccentPreset(preferences.accent)
            ? preferences.accent
            : "default",
      );
      document.documentElement.lang = language;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("sbm.preferences", JSON.stringify(preferences));
    } catch {
      /* Storage may be disabled. */
    }
    return () => media.removeEventListener("change", apply);
  }, [preferences, language]);
  return (
    <UIContext.Provider
      value={{
        preferences,
        language,
        update: (patch) =>
          setPreferences((previous) => ({ ...previous, ...patch })),
        t: (zh, en) => (language === "en" ? en : zh),
      }}
    >
      {children}
    </UIContext.Provider>
  );
}
export function useUI() {
  return useContext(UIContext);
}
