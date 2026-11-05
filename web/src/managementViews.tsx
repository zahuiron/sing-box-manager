import {
  lazy,
  Suspense,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { applyEdits, format } from "jsonc-parser";
import { Dialog, Icon, IconButton, Spinner, useUI } from "./ui";
import {
  Header,
  NoServer,
  environmentLabel,
  stateColor,
  stateLabel,
} from "./views";
import {
  configText,
  inspectConfig,
  parseConfig,
  type Category,
} from "./configuration";
import { protocolSchemas, type Schema } from "./schema/schema.mjs";
import type { ManagedDraft, ServerRecord, Status, WorkingDraft } from "./api";
import type { EditorHandle } from "./Editor";
import { Notice } from "./notifications";
import LibraryActions from "./LibraryActions";
import {
  maskedConfig,
  sectionSchema,
  templateKindAt,
  type LibraryData,
} from "./library";
import type { FieldActions } from "./FieldEditor";

const FieldEditor = lazy(() => import("./FieldEditor"));
const Editor = lazy(() => import("./Editor"));
export interface RemoteState {
  value?: Status;
  error?: string;
  loading?: boolean;
}
export interface DraftState {
  value?: ManagedDraft;
  error?: string;
  loading?: boolean;
}
export interface SchemaState {
  value?: Schema;
  error?: string;
  loading?: boolean;
}

function fieldText(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function Counter({
  title,
  value,
  icon,
}: {
  title: string;
  value: ReactNode;
  icon: "dns" | "play_arrow" | "text_snippet" | "save";
}) {
  return (
    <section className="card">
      <div className="card-header">
        <Icon name={icon} />
        {title}
      </div>
      <div className="text-metric">{value}</div>
    </section>
  );
}

export function FleetView({
  servers,
  states,
  busy,
  refresh,
  add,
  sort,
  navigate,
}: {
  servers: ServerRecord[];
  states: Record<string, RemoteState>;
  busy: boolean;
  refresh: () => void;
  add: () => void;
  sort: () => void;
  navigate: (route: string) => void;
}) {
  const { t } = useUI();
  const [query, setQuery] = useState("");
  const running = servers.filter(
    (server) => states[server.id]?.value?.state === "running",
  ).length;
  const pending = servers.filter(
    (server) =>
      server.configuration &&
      server.configuration.revision !== server.configuration.published_revision,
  ).length;
  const counts = servers.map(
    (server) => server.configuration?.counts?.inbounds,
  );
  const knownNodes = counts.reduce<number>(
    (sum, count) => sum + (count || 0),
    0,
  );
  const allKnown = counts.every((count) => count !== undefined);
  const loading = servers.some((server) => states[server.id]?.loading);
  const visible = servers.filter((server) =>
    `${server.name} ${server.url}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="page">
      <Header title={t("总览", "Overview")}>
        <IconButton
          icon="sync"
          label={t("刷新", "Refresh")}
          disabled={loading || busy}
          onClick={refresh}
        />
        <button
          className="button"
          disabled={busy || servers.length < 2}
          onClick={sort}
        >
          <Icon name="unfold_more" />
          {t("排序", "Sort")}
        </button>
        <button className="button primary" disabled={busy} onClick={add}>
          <Icon name="add" />
          {t("添加服务器", "Add server")}
        </button>
      </Header>
      <div className="fleet-metrics">
        <Counter
          title={t("服务器", "Servers")}
          value={servers.length}
          icon="dns"
        />
        <Counter
          title={t("运行中", "Running")}
          value={loading ? <Spinner /> : running}
          icon="play_arrow"
        />
        <Counter
          title={
            allKnown
              ? t("入站节点", "Inbound nodes")
              : t("已导入节点", "Imported nodes")
          }
          value={
            servers.length && !counts.some((count) => count !== undefined)
              ? "—"
              : knownNodes
          }
          icon="text_snippet"
        />
        <Counter
          title={t("待发布", "Unpublished")}
          value={pending}
          icon="save"
        />
      </div>
      {!!servers.length && (
        <div className="fleet-toolbar">
          <label className="search-input">
            <Icon name="search" />
            <input
              className="input"
              type="search"
              value={query}
              aria-label={t("搜索服务器", "Search servers")}
              placeholder={t("搜索服务器", "Search servers")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="hint">
            {servers.length} {t("台服务器", "servers")}
          </span>
        </div>
      )}
      {!servers.length ? (
        <NoServer onAdd={add} />
      ) : !visible.length ? (
        <div className="empty-state">
          {t("没有匹配的服务器", "No matching servers")}
        </div>
      ) : (
        <div className="fleet-grid">
          {visible.map((server) => {
            const remote = states[server.id],
              summary = server.configuration;
            return (
              <section className="card fleet-server" key={server.id}>
                <button
                  className="server-card-heading"
                  onClick={() => navigate(`servers/${server.id}`)}
                >
                  <Icon name="dns" />
                  <span>
                    <strong>{server.name}</strong>
                    <span className="server-row-url">{server.url}</span>
                  </span>
                  <span className="chevron">
                    <Icon name="expand_more" />
                  </span>
                </button>
                <div className="server-card-status">
                  {remote?.loading ? (
                    <Spinner />
                  ) : (
                    <span
                      className={`state-dot ${remote?.error ? "bad" : stateColor(remote?.value?.state)}`}
                    />
                  )}
                  <span>
                    {remote?.error
                      ? t("连接失败", "Connection failed")
                      : remote?.loading
                        ? t("读取中…", "Loading…")
                        : stateLabel(remote?.value?.state, t)}
                  </span>
                  {environmentLabel(remote?.value?.environment) && (
                    <span className="badge">
                      {environmentLabel(remote?.value?.environment)}
                    </span>
                  )}
                </div>
                {remote?.error && (
                  <Notice message={`${server.name} · ${remote.error}`} />
                )}
                <div className="data-line">
                  <span className="label">
                    {t("入站节点", "Inbound nodes")}
                  </span>
                  <span className="value">
                    {summary?.counts?.inbounds ?? "—"}
                  </span>
                </div>
                <div className="data-line">
                  <span className="label">{t("配置", "Configuration")}</span>
                  <span
                    className={`badge ${summary && summary.revision !== summary.published_revision ? "medium" : ""}`}
                  >
                    {!summary
                      ? t("尚未导入", "Not imported")
                      : summary.revision !== summary.published_revision
                        ? t("有未发布草稿", "Unpublished draft")
                        : t("已同步", "Synced")}
                  </span>
                </div>
                <div className="server-card-actions">
                  <button
                    className="button"
                    onClick={() => navigate(`servers/${server.id}/nodes`)}
                  >
                    {t("管理节点", "Manage nodes")}
                  </button>
                  <button
                    className="button"
                    onClick={() => navigate(`servers/${server.id}/config`)}
                  >
                    {t("配置", "Configuration")}
                  </button>
                  <IconButton
                    icon="terminal"
                    label={t("日志", "Logs")}
                    onClick={() => navigate(`servers/${server.id}/logs`)}
                  />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ServerTabs({
  server,
  active,
  navigate,
}: {
  server: ServerRecord;
  active: string;
  navigate: (route: string) => void;
}) {
  const { t } = useUI();
  return (
    <nav className="server-tabs" aria-label={t("服务器页面", "Server pages")}>
      {[
        ["", t("概览", "Overview")],
        ["nodes", t("节点", "Nodes")],
        ["config", t("配置", "Configuration")],
        ["logs", t("日志", "Logs")],
      ].map(([tab, label]) => (
        <button
          key={tab}
          className={active === tab ? "active" : ""}
          aria-current={active === tab ? "page" : undefined}
          onClick={() =>
            navigate(`servers/${server.id}${tab ? "/" + tab : ""}`)
          }
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export { default as EntriesView } from "./EntriesView";

export function CreateEntryDialog({
  servers,
  selectedId,
  onClose,
  onCreate,
  busy,
}: {
  servers: ServerRecord[];
  selectedId?: string;
  onClose: () => void;
  onCreate: (id: string) => void;
  busy: boolean;
}) {
  const { t } = useUI();
  const [id, setId] = useState(selectedId || servers[0]?.id || "");
  return (
    <Dialog title={t("创建节点", "Create node")} onClose={onClose} busy={busy}>
      <form
        className="node-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(id);
        }}
      >
        <label className="field">
          <span className="field-label">{t("所属服务器", "Server")}</span>
          <select
            className="select"
            value={id}
            disabled={busy}
            onChange={(event) => setId(event.target.value)}
          >
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row-actions dialog-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            {t("取消", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !id}>
            {busy && <Spinner />}
            {t("继续", "Continue")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function DocumentEditor({
  server,
  draft,
  schemaState,
  library,
  category,
  index,
  busy,
  onChange,
  save,
  check,
  publish,
  importRemote,
  restore,
  reload,
  reloadSchema,
  navigate,
}: {
  server: ServerRecord;
  draft: WorkingDraft;
  schemaState: SchemaState;
  library: LibraryData | null;
  category?: Category;
  index?: number;
  busy: boolean;
  onChange: (content: string) => void;
  save: () => Promise<boolean>;
  check: () => void;
  publish: () => void;
  importRemote: () => void;
  restore: () => void;
  reload: () => void;
  reloadSchema: () => void;
  navigate: (route: string) => void;
}) {
  const { t } = useUI();
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const editor = useRef<EditorHandle>(null);
  const parsed = useMemo(() => {
    try {
      return { value: parseConfig(draft.content), error: "" };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : "Invalid JSON",
      };
    }
  }, [draft.content]);
  const isEntry = category !== undefined && index !== undefined;
  const config = parsed.value;
  const catalogue = useMemo(
    () =>
      schemaState.value && category
        ? protocolSchemas(schemaState.value, category)
        : new Map<string, Schema>(),
    [schemaState.value, category],
  );
  const entry =
    isEntry && config && Array.isArray(config[category])
      ? config[category][index]
      : undefined;
  const entrySchema = schemaState.value
    ? isEntry
      ? sectionSchema(schemaState.value, category, entry)
      : schemaState.value
    : undefined;
  const issues = useMemo(
    () => (config ? inspectConfig(config, schemaState.value || null) : []),
    [config, schemaState.value],
  );
  const relevant = issues.filter(
    (issue) =>
      !isEntry ||
      issue.path.startsWith(`/${category}/${index}/`) ||
      issue.path === `/${category}/${index}`,
  );
  const dirty = draft.content !== draft.original;
  function update(value: any) {
    if (isEntry) {
      if (!config || !Array.isArray(config[category])) return;
      const next = structuredClone(config);
      next[category][index] = value;
      onChange(configText(next));
    } else onChange(configText(value));
  }
  const formatJSON = () =>
    onChange(
      applyEdits(
        draft.content,
        format(draft.content, undefined, {
          insertSpaces: true,
          tabSize: 2,
          eol: "\n",
        }),
      ),
    );
  const preview = maskedConfig(entry);
  const renderActions: FieldActions = (path, value, change) => {
    if (!schemaState.value) return null;
    const kind = templateKindAt(schemaState.value, path);
    return kind ? (
      <LibraryActions
        data={library}
        root={schemaState.value}
        kind={kind}
        value={value}
        busy={busy}
        apply={change}
      />
    ) : null;
  };
  return (
    <div className="document-view">
      <div className="document-toolbar">
        {isEntry ? (
          <div className="document-entry-title">
            <span className="badge">
              {category}[{index}]
            </span>
            <strong>
              {fieldText(entry?.tag) || t("节点配置", "Node configuration")}
            </strong>
          </div>
        ) : (
          <div className="segmented">
            <button
              className={mode === "fields" ? "active" : ""}
              onClick={() => setMode("fields")}
            >
              {t("字段", "Fields")}
            </button>
            <button
              className={mode === "json" ? "active" : ""}
              onClick={() => setMode("json")}
            >
              JSON
            </button>
          </div>
        )}
        {(!isEntry ||
          (entry && typeof entry === "object" && !Array.isArray(entry))) &&
          renderActions(
            isEntry ? [category, index] : [],
            isEntry ? entry : config,
            update,
          )}
        <span className="badge">r{draft.revision}</span>
        {dirty && (
          <span className="badge medium">{t("未保存", "Unsaved")}</span>
        )}
        {draft.revision !== draft.published_revision && (
          <span className="badge medium">{t("未发布", "Unpublished")}</span>
        )}
        <div className="document-actions">
          <button className="button" disabled={busy} onClick={check}>
            {t("核心校验", "Core check")}
          </button>
          <button
            className="button"
            disabled={busy || !dirty}
            onClick={() => save()}
          >
            <Icon name="save" />
            {t("保存草稿", "Save draft")}
          </button>
          <button
            className="button primary"
            disabled={
              busy || (!dirty && draft.revision === draft.published_revision)
            }
            onClick={publish}
          >
            {busy && <Spinner />}
            {t("发布配置", "Publish")}
          </button>
        </div>
      </div>
      {draft.source_url !== server.url && (
        <Notice
          message={t(
            "服务器地址已改变，请先导入当前配置。",
            "The server address changed. Import its current configuration first.",
          )}
        />
      )}
      <div className="document-secondary">
        <div className="document-actions">
          <IconButton
            icon="sync"
            label={t("重新读取草稿", "Reload draft")}
            disabled={busy}
            onClick={reload}
          />
          <IconButton
            icon="tune"
            label={t("同步字段定义", "Sync schema")}
            disabled={busy || schemaState.loading}
            onClick={reloadSchema}
          />
          <button
            className="button small"
            disabled={busy}
            onClick={importRemote}
          >
            {t("导入远端", "Import remote")}
          </button>
          <button className="button small" disabled={busy} onClick={restore}>
            {t("恢复发布快照", "Restore published")}
          </button>
        </div>
      </div>
      {mode === "json" && !isEntry ? (
        <>
          <div className="editor-toolbar">
            <span className="text-mono-caption">{server.name}</span>
            <div className="toolbar-actions">
              <IconButton
                icon="undo"
                label={t("撤销", "Undo")}
                disabled={busy}
                onClick={() => editor.current?.undo()}
              />
              <IconButton
                icon="redo"
                label={t("重做", "Redo")}
                disabled={busy}
                onClick={() => editor.current?.redo()}
              />
              <IconButton
                icon="code"
                label={t("格式化", "Format")}
                disabled={busy}
                onClick={formatJSON}
              />
            </div>
          </div>
          <Suspense fallback={<Spinner />}>
            <Editor
              value={draft.content}
              onChange={onChange}
              onSave={() => {
                void save();
              }}
              disabled={busy}
              editorRef={editor}
            />
          </Suspense>
        </>
      ) : parsed.error ? (
        <div className="document-state">
          <p className="field-error">{parsed.error}</p>
          <button
            className="button small"
            onClick={() =>
              isEntry
                ? navigate(`servers/${server.id}/config`)
                : setMode("json")
            }
          >
            {t("使用 JSON 编辑", "Use JSON editor")}
          </button>
        </div>
      ) : schemaState.loading ? (
        <div className="empty-state">
          <Spinner />
          {t("读取目标核心的字段定义…", "Reading the target core schema…")}
        </div>
      ) : !schemaState.value || !entrySchema ? (
        <div className="document-state">
          <Notice message={schemaState.error || ""} />
          <p className="hint">
            {t(
              "字段定义不可用，可重新读取或编辑 JSON",
              "Schema unavailable. Reload it or edit JSON",
            )}
          </p>
          <button className="button small" onClick={reloadSchema}>
            {t("重新读取字段", "Reload schema")}
          </button>
          <button
            className="button small"
            onClick={() =>
              isEntry
                ? navigate(`servers/${server.id}/config`)
                : setMode("json")
            }
          >
            {t("使用 JSON 编辑", "Use JSON editor")}
          </button>
        </div>
      ) : isEntry && !catalogue.size ? (
        <div className="document-state">
          <p className="hint">
            {t(
              "当前核心未提供此类别的字段定义。",
              "This core provides no schema for this category.",
            )}
          </p>
          <button
            className="button small"
            onClick={() => navigate(`servers/${server.id}/config`)}
          >
            {t("使用完整配置编辑", "Edit full configuration")}
          </button>
        </div>
      ) : isEntry &&
        (entry === undefined ||
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry)) ? (
        <div className="document-state">
          <p className="field-error">
            {t(
              "该配置项不存在或不是对象，请打开完整配置修正。",
              "The entry is missing or is not an object. Edit the full configuration.",
            )}
          </p>
        </div>
      ) : (
        <>
          {relevant.length > 0 && (
            <details className="validation-summary">
              <summary>
                {relevant.length} {t("项字段提示", "field issues")}
              </summary>
              {relevant.slice(0, 30).map((issue, index) => (
                <div
                  key={index}
                  className={
                    issue.severity === "warning" ? "hint" : "field-error"
                  }
                >
                  <code>{issue.path}</code> · {issue.message}
                </div>
              ))}
            </details>
          )}
          <div
            className={isEntry ? "node-editor-layout" : "config-fields-layout"}
          >
            <section className="card">
              <Suspense fallback={<Spinner />}>
                <FieldEditor
                  key={`${server.id}:${draft.revision}:${category || "config"}:${index ?? ""}`}
                  value={isEntry ? entry : config}
                  schema={entrySchema}
                  root={schemaState.value}
                  onChange={update}
                  issues={issues}
                  basePath={isEntry ? [category, index] : []}
                  disabled={busy}
                  renderActions={renderActions}
                />
              </Suspense>
            </section>
            {isEntry && (
              <aside className="node-editor-aside">
                <section className="card">
                  <div className="card-header">
                    <Icon name="text_snippet" />
                    {t("JSON 预览", "JSON preview")}
                  </div>
                  <pre className="schema-preview">{preview}</pre>
                  <button
                    className="button"
                    onClick={() => navigate(`servers/${server.id}/config`)}
                  >
                    {t("完整配置", "Full configuration")}
                  </button>
                </section>
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}
