import { useEffect, useId, useRef, useState } from "react";
import { connectPanel, errorText, type Session } from "./api";
import { Dialog, Icon, SecretInput, Spinner, useUI } from "./ui";
import { Header } from "./views";
import shell from "./vendor/Shell.module.css";
import { notify } from "./notifications";
import settings from "./vendor/SettingsView.module.css";

export interface PanelConnection {
  name: string;
  url: string;
  secret: string;
}
const storageKey = "sbm.panels";
const activeKey = "sbm.panel";

function panelURL(value: string) {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "请填写管理面板的 HTTP(S) 地址 / Enter the panel HTTP(S) origin",
    );
  return url.origin;
}

function loadPanels(): { panels: PanelConnection[]; active: string } {
  const result = new Map<string, PanelConnection>();
  let active = "";
  try {
    active = localStorage.getItem(activeKey) || location.origin;
    const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(stored))
      for (const entry of stored.slice(0, 32)) {
        try {
          const url = panelURL(entry.url);
          result.set(url, {
            name:
              typeof entry.name === "string"
                ? entry.name.slice(0, 120) || new URL(url).host
                : new URL(url).host,
            url,
            secret: typeof entry.secret === "string" ? entry.secret : "",
          });
        } catch {}
      }
  } catch {}
  const panels = [...result.values()];
  return { panels, active: result.has(active) ? active : panels[0]?.url || "" };
}

export function normalizePanel(value: PanelConnection): PanelConnection {
  const url = panelURL(value.url);
  if (!/^[\x21-\x7e]{1,1024}$/.test(value.secret))
    throw new Error(
      "密钥需为 1–1024 个可见 ASCII 字符，不含空格 / Secret must contain 1–1024 visible ASCII characters without spaces",
    );
  return {
    name: value.name.trim() || new URL(url).host,
    url,
    secret: value.secret,
  };
}

export function usePanels() {
  const [state, setState] = useState(loadPanels);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        event.key === storageKey ||
        event.key === activeKey ||
        event.key === null
      )
        setState(loadPanels());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  function save(panels: PanelConnection[], active: string) {
    localStorage.setItem(storageKey, JSON.stringify(panels));
    localStorage.setItem(activeKey, active);
    setState({ panels, active });
  }
  function update(next: PanelConnection[]) {
    const index = state.panels.findIndex((panel) => panel.url === state.active);
    const active = next.some((panel) => panel.url === state.active)
      ? state.active
      : next[index]?.url || next[0]?.url || "";
    save(next, active);
  }
  function remember(panel: PanelConnection) {
    const exists = state.panels.some((entry) => entry.url === panel.url);
    if (!exists && state.panels.length >= 32)
      throw new Error("最多保存 32 个面板 / At most 32 panels can be saved");
    save(
      exists
        ? state.panels.map((entry) => (entry.url === panel.url ? panel : entry))
        : [...state.panels, panel],
      panel.url,
    );
  }
  return {
    panels: state.panels,
    update,
    remember,
    select: (panel: PanelConnection) => save(state.panels, panel.url),
    current: state.panels.find((panel) => panel.url === state.active),
  };
}

export function PanelFields({
  value,
  onChange,
}: {
  value: PanelConnection;
  onChange: (value: PanelConnection) => void;
}) {
  const { t } = useUI();
  const id = useId();
  return (
    <>
      <label className="field">
        <span className="field-label">{t("名称", "Name")}</span>
        <input
          className="input"
          maxLength={120}
          value={value.name}
          placeholder={t("可选", "Optional")}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          autoFocus
        />
      </label>
      <label className="field">
        <span className="field-label">URL</span>
        <input
          className="input"
          type="url"
          required
          value={value.url}
          placeholder={t("必填", "Required")}
          onChange={(event) => onChange({ ...value, url: event.target.value })}
          spellCheck={false}
        />
      </label>
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {t("密钥", "Secret")}
        </label>
        <SecretInput
          id={id}
          value={value.secret}
          onChange={(secret) => onChange({ ...value, secret })}
          placeholder={t("必填", "Required")}
          required
        />
      </div>
    </>
  );
}

export function PanelUptime({ session }: { session: Session }) {
  const { t } = useUI();
  const base = useRef({
    seconds: session.uptime_seconds || 0,
    at: performance.now(),
  });
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    base.current = {
      seconds: session.uptime_seconds || 0,
      at: performance.now(),
    };
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [session.started_at, session.uptime_seconds]);
  const seconds = Math.max(
    0,
    Math.floor(base.current.seconds + (now - base.current.at) / 1000),
  );
  const days = Math.floor(seconds / 86400);
  const time = [
    Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return (
    <span
      className={shell["server-uptime"]}
      title={`${t("面板运行时间", "Panel uptime")} · ${session.started_at ? new Date(session.started_at).toLocaleString() : ""}`}
    >
      <Icon name="power_settings_new" size={10} />
      {days ? `${days}d ` : ""}
      {time}
    </span>
  );
}

export function PanelsView({
  panels,
  update,
  navigate,
  currentURL,
}: {
  panels: PanelConnection[];
  update: (value: PanelConnection[]) => void;
  navigate: (route: string) => void;
  currentURL: string;
}) {
  const { t } = useUI();
  const [editing, setEditing] = useState<PanelConnection | null | undefined>();
  return (
    <div className="page">
      <Header title={t("服务器", "Servers")} back={() => navigate("settings")}>
        <button
          type="button"
          className="icon-button"
          aria-label={t("新建服务器", "New Server")}
          title={t("新建服务器", "New Server")}
          onClick={() => setEditing(null)}
        >
          <Icon name="add" size={18} />
        </button>
      </Header>
      <div className="nav-list">
        {panels.map((panel) => (
          <button
            type="button"
            className={settings["server-item"]}
            key={panel.url}
            onClick={() => setEditing(panel)}
          >
            <span className={settings["server-item-text"]}>
              <span className="server-row-name">{panel.name}</span>
              <span className="server-row-url">{panel.url}</span>
            </span>
            <span className="settings-row-chevron">
              <Icon name="keyboard_arrow_right" size={14} />
            </span>
          </button>
        ))}
      </div>
      {editing !== undefined && (
        <PanelDialog
          key={editing?.url || "new"}
          panel={editing}
          panels={panels}
          currentURL={currentURL}
          onClose={() => setEditing(undefined)}
          onSave={(next) => {
            update(next);
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

function PanelDialog({
  panel,
  panels,
  currentURL,
  onClose,
  onSave,
}: {
  panel: PanelConnection | null;
  panels: PanelConnection[];
  currentURL: string;
  onClose: () => void;
  onSave: (value: PanelConnection[]) => void;
}) {
  const { t } = useUI();
  const [value, setValue] = useState<PanelConnection>(
    panel || { name: "", url: "", secret: "" },
  );
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = panel?.url === currentURL;
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const next = normalizePanel(value);
      if (
        panels.some(
          (entry) => entry.url === next.url && entry.url !== panel?.url,
        )
      )
        throw new Error(t("此面板已存在", "This panel already exists"));
      if (!panel && panels.length >= 32)
        throw new Error(
          t("最多保存 32 个面板", "At most 32 panels can be saved"),
        );
      await connectPanel(next);
      onSave(
        panel
          ? panels.map((entry) => (entry.url === panel.url ? next : entry))
          : [...panels, next],
      );
    } catch (error) {
      notify(errorText(error, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        deleting
          ? t("删除面板连接", "Delete panel connection")
          : panel
            ? t("编辑服务器", "Edit server")
            : t("新建服务器", "New Server")
      }
      onClose={onClose}
      busy={busy}
    >
      {deleting ? (
        <>
          <p className="dialog-message">
            {t(
              "仅删除保存的连接，不影响远端面板。",
              "Only remove the saved connection. The remote panel is unaffected.",
            )}
          </p>
          <div className="row-actions dialog-actions">
            <button className="button" onClick={() => setDeleting(false)}>
              {t("取消", "Cancel")}
            </button>
            <button
              className="button danger"
              onClick={() =>
                onSave(panels.filter((entry) => entry.url !== panel?.url))
              }
            >
              {t("删除", "Delete")}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            <PanelFields value={value} onChange={setValue} />
          </fieldset>
          <div className="row-actions dialog-actions">
            <div className="dialog-leading">
              {panel && (!current || panels.length > 1) && (
                <button
                  className="button danger"
                  type="button"
                  disabled={busy}
                  onClick={() => setDeleting(true)}
                >
                  {t("删除", "Delete")}
                </button>
              )}
            </div>
            <button
              className="button"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              {t("取消", "Cancel")}
            </button>
            <button
              className="button primary"
              disabled={busy || !value.url.trim() || !value.secret}
            >
              {busy && <Spinner />}
              {t("保存", "Save")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
