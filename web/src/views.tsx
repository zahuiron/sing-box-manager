// Portions from sing-box-dashboard@3e4bf08 (GPL-3.0-or-later); modified 2026-11-05. See web/THIRD_PARTY.md.
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  api,
  apiFetch,
  errorText,
  isAbort,
  readResponse,
  type ServerInput,
  type ServerRecord,
  type Status,
} from "./api";
import {
  Dialog,
  Icon,
  IconButton,
  SecretInput,
  Spinner,
  useUI,
  type IconName,
} from "./ui";
import { Notice, notify } from "./notifications";
import { appendLogText, cleanLogText } from "./logText";
import { copyText, downloadText } from "./browser";

export type Translate = (zh: string, en: string) => string;
export function stateLabel(state: string | undefined, t: Translate) {
  const labels: Record<string, [string, string]> = {
    running: ["运行中", "Running"],
    stopped: ["已停止", "Stopped"],
    starting: ["正在启动", "Starting"],
    stopping: ["正在停止", "Stopping"],
    failed: ["运行失败", "Failed"],
    unknown: ["未知", "Unknown"],
  };
  return t(...(labels[state || "unknown"] || labels.unknown));
}
export function stateColor(state?: string) {
  return state === "running"
    ? "good"
    : state === "failed"
      ? "bad"
      : state === "starting" || state === "stopping"
        ? "medium"
        : "";
}

export function environmentLabel(environment?: string) {
  switch (environment) {
    case "debian":
      return "Debian";
    case "alpine":
      return "Alpine";
    case "docker":
      return "Docker";
    default:
      return "";
  }
}

export function Header({
  title,
  children,
  back,
}: {
  title: string;
  children?: ReactNode;
  back?: () => void;
}) {
  const { t } = useUI();
  return (
    <div className="page-header">
      {back && (
        <button
          type="button"
          className="back-button"
          aria-label={t("返回", "Back")}
          onClick={back}
        >
          <Icon name="arrow_back" size={20} />
        </button>
      )}
      <h1 className="page-title">{title}</h1>
      {children !== undefined && <div className="actions">{children}</div>}
    </div>
  );
}
export function NoServer({ onAdd }: { onAdd: () => void }) {
  const { t } = useUI();
  return (
    <div className="empty-state">
      <Icon name="dns" />
      <div>
        {t(
          "添加服务器，开始管理 sing-box",
          "Add a server to start managing sing-box",
        )}
      </div>
      <button className="button primary" onClick={onAdd}>
        <Icon name="add" />
        {t("添加服务器", "Add server")}
      </button>
    </div>
  );
}

export function Overview({
  node,
  status,
  loading,
  connected,
  error,
  controlBusy,
  refresh,
  control,
  navigate,
  embedded = false,
}: {
  node: ServerRecord;
  status: Status | null;
  loading: boolean;
  connected: boolean;
  error: string;
  controlBusy: boolean;
  refresh: () => void;
  control: (action: string) => void;
  navigate: (route: string) => void;
  embedded?: boolean;
}) {
  const { t } = useUI();
  return (
    <div className={embedded ? "server-overview" : "page"}>
      {!embedded && (
        <Header title={t("概览", "Overview")}>
          <IconButton
            icon="sync"
            label={t("刷新", "Refresh")}
            disabled={loading || controlBusy}
            onClick={refresh}
          />
        </Header>
      )}
      <Notice message={error ? `${node.name} · ${error}` : ""} />
      <div className="overview-grid">
        <section className="card service-card">
          <div className="card-header">
            <Icon name="play_arrow" />
            <span>sing-box</span>
            {controlBusy && <Spinner />}
          </div>
          <div className="metric-line">
            {loading ? (
              <Spinner />
            ) : (
              <>
                <span className={`state-dot ${stateColor(status?.state)}`} />
                <span className="text-metric">
                  {stateLabel(status?.state, t)}
                </span>
              </>
            )}
          </div>
          <div className="service-actions">
            <button
              className="button primary"
              disabled={
                loading ||
                controlBusy ||
                !connected ||
                status?.state === "running"
              }
              onClick={() => control("start")}
            >
              <Icon name="play_arrow" />
              {t("启动", "Start")}
            </button>
            <button
              className="button"
              disabled={
                loading ||
                controlBusy ||
                !connected ||
                status?.state === "stopped"
              }
              onClick={() => control("stop")}
            >
              <Icon name="stop" />
              {t("停止", "Stop")}
            </button>
            <button
              className="button"
              disabled={loading || controlBusy || !connected}
              onClick={() => control("restart")}
            >
              <Icon name="sync" />
              {t("重启", "Restart")}
            </button>
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <Icon name="dns" />
            {t("服务器", "Server")}
          </div>
          <div className="server-title">{node.name}</div>
          <div className="address">{node.url}</div>
          <div className="connection-state">
            <span
              className={`state-dot ${connected ? "good" : error ? "bad" : ""}`}
            />
            {loading
              ? t("连接中", "Connecting")
              : connected
                ? t("Agent 已连接", "Agent connected")
                : t("Agent 未连接", "Agent disconnected")}
          </div>
          <div className="data-line">
            <span className="label">{t("入站节点", "Inbound nodes")}</span>
            <span className="value">
              {node.configuration?.counts?.inbounds ?? "—"}
            </span>
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <Icon name="memory" />
            {t("版本", "Versions")}
          </div>
          <div className="data-line">
            <span className="label">sing-box</span>
            <span className="value mono">
              {status?.core_version?.replace(/^sing-box version\s*/, "") || "—"}
            </span>
          </div>
          <div className="data-line">
            <span className="label">Agent</span>
            <span className="value mono">{status?.agent_version || "—"}</span>
          </div>
          <div className="data-line">
            <span className="label">{t("运行环境", "Environment")}</span>
            <span className="value mono">
              {environmentLabel(status?.environment) || "—"}
            </span>
          </div>
        </section>
        <section className="card quick-card">
          <div className="card-header">
            <Icon name="tune" />
            {t("管理", "Manage")}
          </div>
          <div className="nav-lines">
            <button className="nav-line" onClick={() => navigate("config")}>
              <Icon name="text_snippet" size={15} />
              <span className="nav-line-label">
                {t("配置文件", "Configuration")}
              </span>
              <Icon name="keyboard_arrow_right" size={14} />
            </button>
            <button className="nav-line" onClick={() => navigate("logs")}>
              <Icon name="terminal" size={15} />
              <span className="nav-line-label">{t("日志", "Logs")}</span>
              <Icon name="keyboard_arrow_right" size={14} />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export function LogsView({
  node,
  suspended,
  embedded = false,
}: {
  node: ServerRecord;
  suspended: boolean;
  embedded?: boolean;
}) {
  const { t } = useUI();
  const [text, setText] = useState("");
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [reconnect, setReconnect] = useState(0);
  const [follow, setFollow] = useState(true);
  const buffer = useRef("");
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (paused || suspended) return;
    const controller = new AbortController();
    buffer.current = "";
    setText("");
    setError("");
    setConnected(false);
    let rendered: string | undefined;
    const flushText = () => {
      if (rendered !== buffer.current) {
        rendered = buffer.current;
        setText(cleanLogText(rendered));
      }
    };
    const timer = window.setInterval(flushText, 200);
    (async () => {
      try {
        const response = await apiFetch(
          `/servers/${encodeURIComponent(node.id)}/agent/logs?lines=200&follow=true`,
          {
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          await readResponse(response);
          return;
        }
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        setConnected(true);
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer.current = appendLogText(
            buffer.current,
            decoder.decode(value, { stream: true }),
          );
        }
        buffer.current = appendLogText(buffer.current, decoder.decode());
        if (!controller.signal.aborted)
          setError(
            t(
              "日志连接已结束，可重新连接",
              "Log stream ended. Reconnect to continue",
            ),
          );
      } catch (error) {
        if (!isAbort(error)) setError(errorText(error, t));
      } finally {
        clearInterval(timer);
        if (!controller.signal.aborted) {
          flushText();
          setConnected(false);
        }
      }
    })();
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [node.id, paused, suspended, reconnect]);
  useEffect(() => {
    if (follow && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [text, follow, search, level]);
  const lines = text
    .split("\n")
    .filter(
      (line) =>
        (!search || line.toLowerCase().includes(search.toLowerCase())) &&
        (level === "all" || new RegExp(`\\b${level}\\b`, "i").test(line)),
    );
  const filtered = lines.join("\n");
  async function copy() {
    try {
      await copyText(filtered);
      notify(t("日志已复制", "Logs copied"), "success");
    } catch (error) {
      notify(errorText(error, t));
    }
  }
  function download() {
    downloadText(
      filtered,
      `${node.name.replace(/[^\w.-]/g, "_")}.log`,
      "text/plain;charset=utf-8",
    );
  }
  function highlight(line: string) {
    if (!search) return line;
    const parts: ReactNode[] = [];
    let offset = 0;
    const lower = line.toLowerCase(),
      term = search.toLowerCase();
    while (offset < line.length) {
      const next = lower.indexOf(term, offset);
      if (next < 0) {
        parts.push(line.slice(offset));
        break;
      }
      parts.push(
        line.slice(offset, next),
        <mark key={next}>{line.slice(next, next + search.length)}</mark>,
      );
      offset = next + search.length;
    }
    return parts;
  }
  function renderLine(line: string) {
    const match = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b/i.exec(line);
    if (!match) return highlight(line);
    return (
      <>
        {highlight(line.slice(0, match.index))}
        <span className={`log-level ${match[1].toLowerCase()}`}>
          {highlight(match[0])}
        </span>
        {highlight(line.slice(match.index + match[0].length))}
      </>
    );
  }
  return (
    <div className={embedded ? "logs-embedded" : "page page-full logs-page"}>
      <Header title={t("日志", "Logs")}>
        <span className={`state-dot ${connected && !paused ? "good" : ""}`} />
        <IconButton
          icon={paused ? "play_arrow" : "pause"}
          label={paused ? t("继续", "Resume") : t("暂停", "Pause")}
          onClick={() => setPaused(!paused)}
        />
        <IconButton
          icon="sync"
          label={t("重新连接", "Reconnect")}
          onClick={() => {
            setPaused(false);
            setReconnect((value) => value + 1);
          }}
        />
        <IconButton
          icon="content_copy"
          label={t("复制", "Copy")}
          onClick={copy}
        />
        <IconButton
          icon="download"
          label={t("导出", "Export")}
          onClick={download}
        />
        <IconButton
          icon="delete"
          label={t("清空显示", "Clear display")}
          onClick={() => {
            buffer.current = "";
            setText("");
          }}
        />
      </Header>
      <Notice message={error ? `${node.name} · ${error}` : ""} />
      <div className="log-toolbar">
        <label className="search-input">
          <Icon name="search" />
          <input
            className="input"
            type="search"
            placeholder={t("搜索日志", "Search logs")}
            aria-label={t("搜索日志", "Search logs")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          className="select inline"
          aria-label={t("日志级别", "Log level")}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          {["all", "error", "warn", "info", "debug", "trace"].map((value) => (
            <option key={value} value={value}>
              {value === "all"
                ? t("全部级别", "All levels")
                : value.toUpperCase()}
            </option>
          ))}
        </select>
        <label className="follow-control">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          {t("跟随", "Follow")}
        </label>
      </div>
      <div
        className="log-output"
        ref={output}
        role="log"
        aria-label={t("sing-box 日志", "sing-box logs")}
      >
        {text ? (
          lines.map((line, index) => (
            <div className="log-line" key={index}>
              {renderLine(line) || "\u00a0"}
            </div>
          ))
        ) : (
          <div className="log-empty">
            {paused
              ? t("已暂停", "Paused")
              : connected
                ? t("等待日志…", "Waiting for logs…")
                : error
                  ? t(
                      "日志连接不可用，可重新连接",
                      "Log connection unavailable. Reconnect to retry",
                    )
                  : t("连接中…", "Connecting…")}
          </div>
        )}
      </div>
    </div>
  );
}

export function ServerDialog({
  node,
  onClose,
  onSaved,
  onDeleted,
}: {
  node: ServerRecord | null;
  onClose: () => void;
  onSaved: (node: ServerRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useUI();
  const initial: ServerInput = {
    id: node?.id,
    name: node?.name || "",
    url: node?.url || "",
    token: "",
    ca_pem: node?.ca_pem || "",
  };
  const [input, setInput] = useState(initial);
  const [advanced, setAdvanced] = useState(!!node?.ca_pem);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "discard" | "">("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function close() {
    if (JSON.stringify(input) !== JSON.stringify(initial))
      setConfirm("discard");
    else onClose();
  }
  async function submit(probe = false) {
    setBusy(true);
    controller.current = new AbortController();
    try {
      if (probe) {
        const status = await api<Status>("/servers/probe", {
          method: "POST",
          json: { ...input, name: input.name || "Server" },
          signal: controller.current.signal,
        });
        if (status.api_version !== 1)
          throw new Error(
            t("Agent API 版本不兼容", "Incompatible Agent API version"),
          );
        notify(
          `${input.name || input.url} · ${t("连接成功", "Connected")} · ${stateLabel(status.state, t)}`,
          "success",
        );
      } else {
        const saved = await api<ServerRecord>(
          node ? `/servers/${node.id}` : "/servers",
          {
            method: node ? "PUT" : "POST",
            json: input,
            signal: controller.current.signal,
          },
        );
        onSaved(saved);
      }
    } catch (error) {
      if (!isAbort(error)) notify(errorText(error, t));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api(`/servers/${node!.id}`, { method: "DELETE" });
      onDeleted(node!.id);
    } catch (error) {
      notify(errorText(error, t));
      setConfirm("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        confirm === "delete"
          ? t("删除服务器", "Delete server")
          : confirm === "discard"
            ? t("放弃修改", "Discard changes")
            : node
              ? t("编辑服务器", "Edit server")
              : t("添加服务器", "Add server")
      }
      onClose={confirm ? () => setConfirm("") : close}
      busy={busy}
    >
      {confirm ? (
        <>
          <p className="dialog-message">
            {confirm === "delete"
              ? `${t("删除", "Delete")} ${node!.name}？${t("仅移除面板记录，保留远端服务。", "Only the panel entry will be removed.")}`
              : t(
                  "服务器信息尚未保存，要放弃修改吗？",
                  "Discard the unsaved server details?",
                )}
          </p>
          <div className="row-actions dialog-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setConfirm("")}
            >
              {t("取消", "Cancel")}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={confirm === "delete" ? remove : onClose}
            >
              {busy && <Spinner />}
              {confirm === "delete"
                ? t("删除", "Delete")
                : t("放弃", "Discard")}
            </button>
          </div>
        </>
      ) : (
        <form
          className="node-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            <label className="field">
              <span className="field-label">{t("名称", "Name")}</span>
              <input
                className="input"
                value={input.name}
                autoFocus
                required
                maxLength={120}
                onChange={(e) => setInput({ ...input, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">URL</span>
              <input
                className="input mono-input"
                type="url"
                value={input.url}
                required
                placeholder="https://node.example.com:9091"
                onChange={(e) => setInput({ ...input, url: e.target.value })}
                spellCheck={false}
              />
            </label>
            <div className="field">
              <label className="field-label" htmlFor="node-token">
                {t("密钥", "Secret")}
              </label>
              <SecretInput
                id="node-token"
                value={input.token}
                onChange={(token) => setInput({ ...input, token })}
                required={!node}
                placeholder={
                  node
                    ? t("留空保留原 Token", "Leave empty to keep the token")
                    : "Agent Token"
                }
              />
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => setAdvanced(!advanced)}
            >
              <Icon name={advanced ? "expand_less" : "expand_more"} />
              {t("受信 CA（可选）", "Trusted CA (optional)")}
            </button>
            {advanced && (
              <label className="field">
                <span className="field-label">PEM</span>
                <textarea
                  className="input ca-input"
                  rows={5}
                  value={input.ca_pem}
                  onChange={(e) =>
                    setInput({ ...input, ca_pem: e.target.value })
                  }
                  placeholder="-----BEGIN CERTIFICATE-----"
                  spellCheck={false}
                />
              </label>
            )}
          </fieldset>
          <div className="row-actions dialog-actions">
            <div className="dialog-leading">
              {node && (
                <button
                  type="button"
                  className="button danger"
                  disabled={busy}
                  onClick={() => setConfirm("delete")}
                >
                  {t("删除", "Delete")}
                </button>
              )}
            </div>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => submit(true)}
            >
              {t("测试连接", "Test")}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={close}
            >
              {t("取消", "Cancel")}
            </button>
            <button className="button primary" disabled={busy}>
              {busy && <Spinner />}
              {t("保存", "Save")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function NavRow({
  icon,
  title,
  detail,
  onClick,
  href,
  disabled = false,
}: {
  icon: IconName;
  title: string;
  detail?: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Icon name={icon} size={15} />
      <span>{title}</span>
      {detail != null && <span className="nav-row-detail">{detail}</span>}
      <Icon name={href ? "open_in_new" : "keyboard_arrow_right"} size={14} />
    </>
  );
  return href ? (
    <a className="nav-row" href={href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <button
      type="button"
      className="nav-row"
      onClick={onClick}
      disabled={disabled}
    >
      {content}
    </button>
  );
}
