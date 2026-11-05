import type { ManagedDraft, ServerRecord } from "./api";
import type { DraftState } from "./managementViews";
import { entries, parseConfig } from "./configuration";
import { Icon, IconButton, Spinner, useUI } from "./ui";
import { Header } from "./views";
import { Notice } from "./notifications";

type Entry = { entry: Record<string, any>; index: number };
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

export default function EntriesView({
  servers,
  documents,
  scoped,
  add,
  edit,
  duplicate,
  remove,
  navigate,
  refresh,
  busy,
}: {
  servers: ServerRecord[];
  documents: Record<string, DraftState>;
  scoped?: string;
  add: (serverId?: string) => void;
  edit: (id: string, index: number) => void;
  duplicate: (id: string, index: number) => void;
  remove: (id: string, index: number) => void;
  navigate: (route: string) => void;
  refresh: () => void;
  busy: boolean;
}) {
  const { t } = useUI();
  const selected = servers.filter((server) => !scoped || server.id === scoped);
  const loading = selected.some((server) => documents[server.id]?.loading);
  const actions = (
    <>
      <IconButton
        icon="sync"
        label={t("刷新", "Refresh")}
        disabled={loading || busy}
        onClick={refresh}
      />
      <button
        className="button primary"
        disabled={!servers.length || busy}
        onClick={() => add(scoped)}
      >
        <Icon name="add" />
        {t("创建节点", "Create node")}
      </button>
    </>
  );
  return (
    <div className={scoped ? "entries-view" : "page"}>
      {scoped ? (
        <div className="entries-toolbar">{actions}</div>
      ) : (
        <Header title={t("节点", "Nodes")}>{actions}</Header>
      )}
      {loading && (
        <div className="list-loading">
          <Spinner />
          {t("读取服务器配置…", "Reading server configurations…")}
        </div>
      )}
      {!selected.length && (
        <div className="empty-state">
          {t("尚未添加服务器", "No servers added")}
        </div>
      )}
      {selected.map((server) => {
        const document = documents[server.id];
        let error = document?.error || "";
        let rows: Entry[] = [];
        if (document?.value && !error) {
          try {
            const config = parseConfig(document.value.content);
            rows = entries(config, "inbounds").map((entry, index) => ({
              entry:
                entry && typeof entry === "object" && !Array.isArray(entry)
                  ? entry
                  : {},
              index,
            }));
          } catch (failure) {
            error =
              failure instanceof Error
                ? failure.message
                : t("无法读取草稿", "Cannot read draft");
          }
        }
        return (
          <section className="entries-server" key={server.id}>
            {!scoped && (
              <div className="entries-server-heading">
                <button
                  className="table-title"
                  onClick={() => navigate(`servers/${server.id}`)}
                >
                  {server.name}
                </button>
                <span className="text-mono-caption">{server.url}</span>
                <button
                  className="button small"
                  onClick={() => navigate(`servers/${server.id}/config`)}
                >
                  {t("配置", "Configuration")}
                </button>
              </div>
            )}
            {error ? (
              <div className="entries-empty">
                <Notice message={`${server.name} · ${error}`} />
                <button
                  className="button small"
                  onClick={() => navigate(`servers/${server.id}/config`)}
                >
                  {t("查看配置", "View configuration")}
                </button>
              </div>
            ) : !document?.value ? null : !rows.length ? (
              <div className="entries-empty hint">
                {t("暂无节点", "No nodes")}
              </div>
            ) : (
              <section className="entries-category">
                <div className="list-section-title">
                  {t("入站", "Inbounds")}
                  <span className="badge">{rows.length}</span>
                </div>
                <EntryTable
                  rows={rows}
                  draft={document.value}
                  busy={busy}
                  edit={(index) => edit(server.id, index)}
                  duplicate={(index) => duplicate(server.id, index)}
                  remove={(index) => remove(server.id, index)}
                />
              </section>
            )}
          </section>
        );
      })}
    </div>
  );
}

function EntryTable({
  rows,
  draft,
  busy,
  edit,
  duplicate,
  remove,
}: {
  rows: Entry[];
  draft: ManagedDraft;
  busy: boolean;
  edit: (index: number) => void;
  duplicate: (index: number) => void;
  remove: (index: number) => void;
}) {
  const { t } = useUI();
  return (
    <div className="table-wrap">
      <table className="entry-table">
        <colgroup>
          <col className="entry-col-name" />
          <col className="entry-col-protocol" />
          <col />
          <col className="entry-col-configuration" />
          <col className="entry-col-actions" />
        </colgroup>
        <thead>
          <tr>
            {[
              t("节点 / 标签", "Node / tag"),
              t("协议", "Protocol"),
              t("监听", "Listen"),
              t("配置", "Configuration"),
              "",
            ].map((label, index) => (
              <th key={index} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ entry, index }) => (
            <tr key={index}>
              <td>
                <button className="table-title" onClick={() => edit(index)}>
                  {text(entry.tag) || t("未设置 tag", "No tag")}
                </button>
                <div className="table-sub">
                  inbounds[{index}]
                </div>
              </td>
              <td>
                <span className="badge text-mono-caption">
                  {text(entry.type) || t("未选择", "Not selected")}
                </span>
              </td>
              <td className="text-mono-caption">
                {text(entry.listen) || "—"}
                {text(entry.listen_port) ? `:${text(entry.listen_port)}` : ""}
              </td>
              <td>
                <span
                  className={`badge ${draft.revision !== draft.published_revision ? "medium" : ""}`}
                >
                  {draft.revision !== draft.published_revision
                    ? t("未发布", "Unpublished")
                    : t("已同步", "Synced")}
                </span>
              </td>
              <td>
                <div className="entry-actions">
                  <IconButton
                    icon="tune"
                    label={t("编辑节点", "Edit node")}
                    disabled={busy}
                    onClick={() => edit(index)}
                  />
                  <IconButton
                    icon="content_copy"
                    label={t("复制节点", "Duplicate node")}
                    disabled={busy}
                    onClick={() => duplicate(index)}
                  />
                  <IconButton
                    icon="delete"
                    label={t("删除节点", "Delete node")}
                    disabled={busy}
                    onClick={() => remove(index)}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
