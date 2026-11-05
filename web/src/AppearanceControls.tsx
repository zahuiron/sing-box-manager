import { Icon, useUI } from "./ui";
import { ThemeMenu, ThemeSelect, Select } from "./vendor/PreferenceControls";
import {
  isAccentPreset,
  normalizeAccentColor,
  type AccentPreference,
} from "./theme";
import settings from "./vendor/SettingsView.module.css";
import setup from "./vendor/SetupView.module.css";

export default function AppearanceControls({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { preferences, update, t } = useUI();
  const accent =
    preferences.accent === "custom"
      ? normalizeAccentColor(preferences.color) || "#4a7ba6"
      : isAccentPreset(preferences.accent)
        ? preferences.accent
        : "default";
  const onAccentChange = (value: AccentPreference) =>
    update(
      isAccentPreset(value)
        ? { accent: value }
        : { accent: "custom", color: value },
    );
  const rows = (
    <>
      <div className="settings-row">
        {!compact && <Icon name="brightness_auto" size={15} />}
        <span className="settings-row-label">{t("外观", "Appearance")}</span>
        <ThemeSelect
          theme={preferences.appearance}
          onChange={(appearance) => update({ appearance })}
        />
      </div>
      <div className="settings-row">
        {!compact && <Icon name="palette" size={15} />}
        <span className="settings-row-label">{t("主题", "Theme")}</span>
        <ThemeMenu accent={accent} onChange={onAccentChange} openUp={compact} />
      </div>
      <div className="settings-row">
        {!compact && <Icon name="language" size={15} />}
        <span className="settings-row-label">{t("语言", "Language")}</span>
        <Select<"auto" | "zh-CN" | "en">
          inline
          options={[
            { value: "auto", label: t("跟随系统", "System") },
            { value: "zh-CN", label: "简体中文" },
            { value: "en", label: "English" },
          ]}
          value={preferences.language}
          onChange={(language) => update({ language })}
        />
      </div>
    </>
  );
  return compact ? (
    <div className={setup["setup-footer"]}>{rows}</div>
  ) : (
    <div className="settings-stack">
      <div className={settings["settings-list"]}>{rows}</div>
    </div>
  );
}
