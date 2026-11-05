// Portions from sing-box-dashboard@3e4bf08 (GPL-3.0-or-later); modified 2026-11-05. See web/THIRD_PARTY.md.
import { useEffect, useRef, useState } from "react";
import {
  agent,
  api,
  APIError,
  errorText,
  isAbort,
  type ManagedDraft,
  type ServerRecord,
  type Session,
  type Status,
  type WorkingDraft,
} from "./api";
import { Dialog, Icon, IconButton, Spinner, useUI, type IconName } from "./ui";
import {
  Header,
  LogsView,
  NavRow,
  ServerDialog,
  Overview,
  stateLabel,
} from "./views";
import {
  CreateEntryDialog,
  DocumentEditor,
  EntriesView,
  FleetView,
  ServerTabs,
  type DraftState,
  type RemoteState,
  type SchemaState,
} from "./managementViews";
import {
  categories,
  configText,
  entries,
  parseConfig,
} from "./configuration";
import type { Schema } from "./schema/schema.mjs";
import shell from "./vendor/Shell.module.css";
import { Notice, notify } from "./notifications";
import AppearanceControls from "./AppearanceControls";
import BackupView from "./BackupView";
import ServerOrderDialog from "./ServerOrderDialog";
import { TemplatesView, type LibraryViewProps } from "./LibraryViews";
import { useLibrary } from "./library";
import SubscriptionsView from "./SubscriptionsView";
import { PanelUptime, PanelsView, type PanelConnection } from "./Panels";

const routeFromHash = () => {
  const route =
    location.hash.replace(/^#\/?/, "").replace(/\/$/, "") || "overview";
  const legacyEntry =
    /^nodes\/([^/]+)\/(?:outbounds|endpoints|services)\/\d+$/.exec(route);
  if (legacyEntry) return `servers/${legacyEntry[1]}/config`;
  return route === "settings/account"
    ? "settings"
    : route === "servers"
      ? "overview"
      : route === "users"
        ? "templates/users"
        : route;
};
type Confirmation = {
  title: string;
  message: string;
  run: () => void;
  danger?: boolean;
};
const localDirty = (draft: WorkingDraft | null) =>
  !!draft && draft.content !== draft.original;

export default function Management({
  session,
  suspended,
  onLogout,
  panels,
  currentPanel,
  updatePanels,
  onSelectPanel,
}: {
  session: Session;
  suspended: boolean;
  onLogout: () => void;
  panels: PanelConnection[];
  currentPanel: PanelConnection;
  updatePanels: (value: PanelConnection[]) => void;
  onSelectPanel: (panel: PanelConnection) => void;
}) {
  const { t } = useUI();
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const serverRef = useRef(servers);
  serverRef.current = servers;
  const [loading, setLoading] = useState(true);
  const listRequest = useRef<AbortController | null>(null);
  const [listError, setListError] = useState("");
  const [activeId, setActiveId] = useState(() => {
    try {
      return localStorage.getItem("sbm.server") || "";
    } catch {
      return "";
    }
  });
  const [route, setRoute] = useState(routeFromHash);
  const [states, setStates] = useState<Record<string, RemoteState>>({});
  const [documents, setDocuments] = useState<Record<string, DraftState>>({});
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [schemas, setSchemas] = useState<Record<string, SchemaState>>({});
  const schemaCache = useRef<Record<string, string>>({});
  const [working, setWorking] = useState<WorkingDraft | null>(null);
  const workingRef = useRef(working);
  workingRef.current = working;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [draftRefresh, setDraftRefresh] = useState(0);
  const [schemaRefresh, setSchemaRefresh] = useState(0);
  const [editServer, setEditServer] = useState<
    ServerRecord | null | undefined
  >();
  const [sortingServers, setSortingServers] = useState(false);
  const [createEntry, setCreateEntry] = useState<{
    id?: string;
  } | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 720px)").matches,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const parts = route.split("/");
  const isEntry =
    parts[0] === "nodes" &&
    parts.length === 4 &&
    parts[2] === "inbounds" &&
    /^\d+$/.test(parts[3]);
  const serverId =
    parts[0] === "servers" && parts[1]
      ? parts[1]
      : isEntry
        ? parts[1]
        : ["config", "logs"].includes(route)
          ? activeId
          : "";
  const tab = isEntry
    ? "entry"
    : route === "config" || route === "logs"
      ? route
      : parts[0] === "servers" && parts[1]
        ? parts[2] || ""
        : "";
  const server = servers.find((value) => value.id === serverId);
  const dirty = localDirty(working);
  const globalFleet = route === "overview";
  const globalEntries = route === "nodes";
  const activeNav =
    parts[0] === "servers" || ["config", "logs"].includes(route)
      ? "overview"
      : parts[0];
  const needsDocument = !!server && tab !== "logs";
  const libraryRoute = parts[0] === "templates" || route === "subscriptions";
  const needsSchema = !!server && (tab === "config" || tab === "entry");
  const library = useLibrary(libraryRoute || needsSchema, suspended);

  function assignWorking(value: WorkingDraft | null) {
    workingRef.current = value;
    setWorking(value);
  }
  function commitRoute(next: string) {
    history.pushState(null, "", `#/${next}`);
    setRoute(next);
    setPickerOpen(false);
    setNavOpen(false);
  }
  function guard(action: () => void) {
    if (busyRef.current) return;
    if (localDirty(workingRef.current)) setPending(() => action);
    else action();
  }
  function navigate(next: string) {
    if (next === route) return;
    guard(() => commitRoute(next));
  }
  function selectPanel(panel: PanelConnection) {
    guard(() => {
      setPickerOpen(false);
      if (panel.url !== currentPanel.url) onSelectPanel(panel);
    });
  }
  function updateContent(content: string) {
    if (workingRef.current && !busyRef.current)
      assignWorking({ ...workingRef.current, content });
  }

  function acceptDraft(id: string, draft: ManagedDraft, select = false) {
    const known = documentsRef.current[id]?.value;
    if (
      known &&
      (draft.revision < known.revision ||
        (draft.revision === known.revision &&
          draft.published_revision < known.published_revision))
    )
      return false;
    documentsRef.current = { ...documentsRef.current, [id]: { value: draft } };
    setDocuments(documentsRef.current);
    let counts: Record<string, number> | undefined;
    try {
      const value = parseConfig(draft.content);
      counts = Object.fromEntries(
        categories
          .filter(
            (category) =>
              value[category] === undefined || Array.isArray(value[category]),
          )
          .map((category) => [category, value[category]?.length || 0]),
      );
    } catch {
      counts = undefined;
    }
    setServers((previous) =>
      previous.map((server) =>
        server.id === id
          ? {
              ...server,
              configuration: {
                revision: draft.revision,
                published_revision: draft.published_revision,
                counts,
                updated_at: draft.updated_at,
              },
            }
          : server,
      ),
    );
    if (select)
      assignWorking({ ...draft, serverId: id, original: draft.content });
    return true;
  }

  async function perform(
    operation: () => Promise<void>,
    success = "",
  ): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await operation();
      if (success) notify(success, "success");
      return true;
    } catch (error) {
      notify(errorText(error, t));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function persist(id: string, content: string, revision: number) {
    const draft = await api<ManagedDraft>(`/servers/${id}/draft`, {
      method: "PUT",
      json: { content, revision },
    });
    acceptDraft(id, draft, true);
    return draft;
  }
  async function saveWorking(): Promise<boolean> {
    const snapshot = workingRef.current;
    if (!snapshot) return false;
    const target =
      servers.find((server) => server.id === snapshot.serverId)?.name || "";
    return perform(
      async () => {
        await persist(snapshot.serverId, snapshot.content, snapshot.revision);
      },
      `${target} · ${t("草稿已保存，远端未改变", "Draft saved; server unchanged")}`,
    );
  }

  useEffect(() => {
    if (suspended) return;
    const controller = new AbortController();
    listRequest.current = controller;
    if (!serverRef.current.length) setLoading(true);
    setListError("");
    api<ServerRecord[]>("/servers", { signal: controller.signal })
      .then((values) => {
        if (controller.signal.aborted) return;
        setServers(values);
        setActiveId((previous) =>
          values.some((value) => value.id === previous)
            ? previous
            : values[0]?.id || "",
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbort(error))
          setListError(errorText(error, t));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [suspended, refresh]);
  useEffect(() => {
    try {
      localStorage.setItem("sbm.server", activeId);
    } catch {}
  }, [activeId]);
  useEffect(() => {
    if (serverId && server) setActiveId(serverId);
  }, [serverId, server?.id]);
  const targets = globalFleet ? servers : server ? [server] : [];
  const statusKey = targets
    .map((value) => `${value.id}:${value.url}:${value.ca_pem || ""}`)
    .sort()
    .join("|");
  useEffect(() => {
    if (suspended || !targets.length) return;
    const controller = new AbortController();
    const queue = [...targets];
    setStates((previous) => {
      const next = { ...previous };
      for (const target of queue)
        next[target.id] = { ...next[target.id], loading: true, error: "" };
      return next;
    });
    async function worker() {
      while (queue.length && !controller.signal.aborted) {
        const target = queue.shift()!;
        try {
          const value = await agent<Status>(target.id, "status", {
            signal: controller.signal,
          });
          if (value.api_version !== 1)
            throw new Error(
              t("Agent API 版本不兼容", "Incompatible Agent API version"),
            );
          if (!controller.signal.aborted)
            setStates((previous) => ({ ...previous, [target.id]: { value } }));
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return;
          const value =
            error instanceof APIError &&
            ["state_unknown", "version_unavailable"].includes(error.code)
              ? {
                  state: error.result?.state || "unknown",
                  core_version: "",
                  agent_version: "",
                  driver: "",
                  environment: error.result?.environment,
                  api_version: 1,
                }
              : undefined;
          setStates((previous) => ({
            ...previous,
            [target.id]: { value, error: errorText(error, t) },
          }));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return () => controller.abort();
  }, [statusKey, refresh, suspended]);

  const documentKey = globalEntries
    ? servers
        .map((value) => `${value.id}:${value.url}`)
        .sort()
        .join("|")
    : needsDocument
      ? serverId
      : "";
  useEffect(() => {
    if (suspended || !documentKey) return;
    const controller = new AbortController();
    const queue = globalEntries
      ? [...serverRef.current]
      : serverRef.current.filter((value) => value.id === serverId);
    for (const target of queue)
      setDocuments((previous) => ({
        ...previous,
        [target.id]: { ...previous[target.id], loading: true, error: "" },
      }));
    async function worker() {
      while (queue.length && !controller.signal.aborted) {
        const target = queue.shift()!;
        try {
          const draft = await api<ManagedDraft>(`/servers/${target.id}/draft`, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (!acceptDraft(target.id, draft)) continue;
          if (
            target.id === serverId &&
            (!workingRef.current ||
              workingRef.current.serverId !== target.id ||
              !localDirty(workingRef.current))
          )
            assignWorking({
              ...draft,
              serverId: target.id,
              original: draft.content,
            });
        } catch (error) {
          if (!controller.signal.aborted && !isAbort(error))
            setDocuments((previous) => ({
              ...previous,
              [target.id]: {
                ...previous[target.id],
                loading: false,
                error: errorText(error, t),
              },
            }));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return () => controller.abort();
  }, [documentKey, globalEntries, draftRefresh, suspended]);

  useEffect(() => {
    if (!needsSchema || suspended || !server) return;
    const id = server.id,
      controller = new AbortController();
    const key = `${server.url}:${schemaRefresh}`;
    if (schemaCache.current[id] === key) return;
    setSchemas((previous) => ({
      ...previous,
      [id]: { ...previous[id], loading: true, error: "" },
    }));
    agent<{ schema: Schema }>(id, "schema", { signal: controller.signal })
      .then((value) => {
        if (!value.schema || typeof value.schema !== "object")
          throw new Error(
            t("目标核心没有返回字段定义", "The core returned no schema"),
          );
        if (!controller.signal.aborted) {
          schemaCache.current[id] = key;
          setSchemas((previous) => ({
            ...previous,
            [id]: { value: value.schema },
          }));
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbort(error))
          setSchemas((previous) => ({
            ...previous,
            [id]: { error: errorText(error, t) },
          }));
      });
    return () => controller.abort();
  }, [server?.id, server?.url, needsSchema, schemaRefresh, suspended]);

  useEffect(() => {
    const changed = () => {
      const next = routeFromHash();
      if (next !== route) {
        history.replaceState(null, "", `#/${route}`);
        guard(() => commitRoute(next));
      }
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [route, dirty, busy]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    const media = matchMedia("(max-width: 720px)");
    const changed = () => {
      setMobile(media.matches);
      setNavOpen(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("pointerdown", close);
    picker.current
      ?.querySelector<HTMLButtonElement>("[aria-checked='true']")
      ?.focus();
    return () => window.removeEventListener("pointerdown", close);
  }, [pickerOpen]);
  useEffect(() => {
    if (!navOpen) return;
    const previous = document.activeElement as HTMLElement;
    sidebar.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavOpen(false);
        previous?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navOpen]);

  function showPublish() {
    const snapshot = workingRef.current;
    if (!snapshot) return;
    const name =
      servers.find((server) => server.id === snapshot.serverId)?.name || "";
    setConfirmation({
      title: t("发布配置", "Publish configuration"),
      message: `${name} · ${t("保存当前草稿后，由目标核心校验并写入远端；正在运行的服务会重启。", "Save this draft, validate it with the target core and write it to the server. A running service will restart.")}`,
      run: () => {
        void perform(async () => {
          const saved = localDirty(snapshot)
            ? await persist(
                snapshot.serverId,
                snapshot.content,
                snapshot.revision,
              )
            : snapshot;
          const result = await api<{
            draft: ManagedDraft;
            applied: boolean;
            state: string;
          }>(`/servers/${snapshot.serverId}/publish`, {
            method: "POST",
            json: { revision: saved.revision },
          });
          acceptDraft(snapshot.serverId, result.draft, true);
          setRefresh((value) => value + 1);
          notify(
            `${name} · ${result.applied ? t("配置已发布并应用", "Configuration published and applied") : t("配置已发布，未启动服务", "Configuration published without starting the service")}`,
            "success",
          );
        });
      },
    });
  }
  function showImport() {
    const snapshot = workingRef.current;
    if (!snapshot) return;
    setConfirmation({
      title: t("导入远端配置", "Import remote configuration"),
      message: t(
        "将远端当前文件作为新的基线，替换中心草稿及发布快照。未发布修改将被覆盖。",
        "Replace the central draft and published snapshot with the current remote file. Unpublished edits will be replaced.",
      ),
      danger: true,
      run: () => {
        void perform(
          async () => {
            const value = await api<ManagedDraft>(
              `/servers/${snapshot.serverId}/draft/import`,
              { method: "POST", json: { revision: snapshot.revision } },
            );
            acceptDraft(snapshot.serverId, value, true);
          },
          t("远端配置已导入", "Remote configuration imported"),
        );
      },
    });
  }
  function showRestore() {
    const snapshot = workingRef.current;
    if (!snapshot) return;
    setConfirmation({
      title: t("恢复发布快照", "Restore published snapshot"),
      message: t(
        "将最近的发布快照恢复为草稿；再次发布后才改变远端。当前草稿修改将被替换。",
        "Restore the latest published snapshot as a draft. The server changes only after publishing. Current draft edits will be replaced.",
      ),
      danger: true,
      run: () => {
        void perform(
          async () => {
            const value = await api<ManagedDraft>(
              `/servers/${snapshot.serverId}/draft/restore`,
              { method: "POST", json: { revision: snapshot.revision } },
            );
            acceptDraft(snapshot.serverId, value, true);
          },
          t("发布快照已恢复到草稿", "Published snapshot restored to draft"),
        );
      },
    });
  }
  function coreCheck() {
    const snapshot = workingRef.current;
    if (!snapshot) return;
    void perform(
      async () => {
        await agent(snapshot.serverId, "config/check", {
          method: "POST",
          json: { content: snapshot.content },
        });
      },
      t("目标核心校验通过", "Target core validation passed"),
    );
  }
  function control(action: string) {
    if (!server) return;
    const target = server;
    const run = () => {
      void perform(
        async () => {
          try {
            await agent(target.id, `service/${action}`, { method: "POST" });
          } finally {
            setRefresh((value) => value + 1);
          }
        },
        `${target.name} · ${t("服务操作已完成", "Service operation completed")}`,
      );
    };
    if (action === "start") run();
    else
      setConfirmation({
        title:
          action === "stop"
            ? t("停止服务", "Stop service")
            : t("重启服务", "Restart service"),
        message: `${target.name} · ${t("会中断该服务器现有连接，Agent 保持在线。", "Active connections on this server will be interrupted. Agent stays online.")}`,
        danger: action === "stop",
        run,
      });
  }
  function addEntry(id?: string) {
    guard(() => setCreateEntry({ id }));
  }
  function beginEntry(id: string) {
    setCreateEntry(null);
    void perform(async () => {
      const snapshot = await api<ManagedDraft>(`/servers/${id}/draft`);
      acceptDraft(id, snapshot);
      const config = parseConfig(snapshot.content),
        list = entries(config, "inbounds");
      config.inbounds = [...list, {}];
      assignWorking({
        ...snapshot,
        content: configText(config),
        original: snapshot.content,
        serverId: id,
      });
      setActiveId(id);
      commitRoute(`nodes/${id}/inbounds/${list.length}`);
    });
  }
  function editEntry(id: string, index: number) {
    navigate(`nodes/${id}/inbounds/${index}`);
  }
  function duplicateEntry(id: string, index: number) {
    guard(() => {
      void perform(
        async () => {
          const snapshot = documentsRef.current[id]?.value;
          if (!snapshot)
            throw new Error(
              t("请重新读取该服务器配置", "Reload the server configuration"),
            );
          const config = parseConfig(snapshot.content),
            list = entries(config, "inbounds"),
            item = list[index];
          if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error(
              t(
                "配置项不是对象，请使用完整配置修正",
                "The entry is not an object. Edit the full configuration",
              ),
            );
          const copy = structuredClone(item),
            taken = new Set(list.map((value) => value?.tag));
          let tag = `${item.tag || item.type || "node"}-copy`,
            sequence = 2;
          while (taken.has(tag))
            tag = `${item.tag || item.type || "node"}-copy-${sequence++}`;
          copy.tag = tag;
          config.inbounds = [...list, copy];
          await persist(id, configText(config), snapshot.revision);
          setActiveId(id);
          commitRoute(`nodes/${id}/inbounds/${list.length}`);
        },
        t(
          "已复制到草稿，请检查监听端口和引用",
          "Copied to draft. Check listen ports and references",
        ),
      );
    });
  }
  function removeEntry(id: string, index: number) {
    const snapshot = documentsRef.current[id]?.value;
    if (!snapshot) return;
    guard(() =>
      setConfirmation({
        title: t("删除节点草稿", "Delete node from draft"),
        message: t(
          "仅从中心草稿移除，发布后才影响服务器。",
          "Remove the entry from the central draft. The server changes only after publishing.",
        ),
        danger: true,
        run: () => {
          void perform(
            async () => {
              const config = parseConfig(snapshot.content),
                list = entries(config, "inbounds");
              config.inbounds = list.filter((_, item) => item !== index);
              await persist(id, configText(config), snapshot.revision);
            },
            t(
              "节点已从草稿移除，尚未发布",
              "Node removed from draft; not published",
            ),
          );
        },
      }),
    );
  }
  const nav: [string, IconName, string][] = [
    ["overview", "dashboard", t("总览", "Overview")],
    ["nodes", "text_snippet", t("节点", "Nodes")],
    ["templates", "content_copy", t("模板", "Templates")],
    ["subscriptions", "share", t("订阅", "Subscriptions")],
    ["settings", "settings", t("设置", "Settings")],
  ];
  const currentWorking = working?.serverId === serverId ? working : null;
  const remote = server ? states[server.id] : undefined;
  const libraryProps: LibraryViewProps = {
    data: library.data,
    loading: library.loading,
    error: library.error,
    busy,
    reload: library.reload,
    save: (next, message) => perform(() => library.persist(next), message),
    confirm: (title, message, run) =>
      setConfirmation({ title, message, run, danger: true }),
  };

  let content;
  if (listError)
    content = (
      <div className="page">
        <Notice message={listError} />
        <button
          className="button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("重试", "Retry")}
        </button>
      </div>
    );
  else if (loading)
    content = (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  else if (globalFleet)
    content = (
      <FleetView
        servers={servers}
        states={states}
        busy={busy}
        add={() => guard(() => setEditServer(null))}
        sort={() => guard(() => setSortingServers(true))}
        refresh={() => setRefresh((value) => value + 1)}
        navigate={navigate}
      />
    );
  else if (globalEntries)
    content = (
      <EntriesView
        servers={servers}
        documents={documents}
        add={addEntry}
        edit={editEntry}
        duplicate={duplicateEntry}
        remove={removeEntry}
        navigate={navigate}
        refresh={() => setDraftRefresh((value) => value + 1)}
        busy={busy}
      />
    );
  else if (parts[0] === "templates")
    content = (
      <TemplatesView
        {...libraryProps}
        category={
          parts[1] === "users"
            ? "users"
            : parts[1] === "client"
              ? "client"
              : "server"
        }
        onCategoryChange={(category) =>
          navigate(
            category === "server" ? "templates" : `templates/${category}`,
          )
        }
      />
    );
  else if (route === "subscriptions")
    content = <SubscriptionsView {...libraryProps} suspended={suspended} />;
  else if (route === "settings/preferences")
    content = (
      <div className="page">
        <Header
          title={t("偏好", "Preferences")}
          back={() => navigate("settings")}
        />
        <AppearanceControls />
      </div>
    );
  else if (route === "settings/servers")
    content = (
      <PanelsView
        panels={panels}
        update={updatePanels}
        navigate={navigate}
        currentURL={currentPanel.url}
      />
    );
  else if (route === "settings/backup")
    content = (
      <BackupView
        busy={busy}
        back={() => navigate("settings")}
        perform={perform}
        onRestored={() => {
          listRequest.current?.abort();
          assignWorking(null);
          documentsRef.current = {};
          setDocuments({});
          setSchemas({});
          schemaCache.current = {};
          setStates({});
          setServers([]);
          setActiveId("");
          setRefresh((value) => value + 1);
          setDraftRefresh((value) => value + 1);
          setSchemaRefresh((value) => value + 1);
          library.reload();
          commitRoute("overview");
        }}
      />
    );
  else if (route === "settings")
    content = (
      <div className="page">
        <Header title={t("设置", "Settings")} />
        <div className="settings-stack">
          <div className="nav-list">
            <NavRow
              icon="tune"
              title={t("偏好", "Preferences")}
              onClick={() => navigate("settings/preferences")}
            />
            <NavRow
              icon="dns"
              title={t("服务器", "Servers")}
              onClick={() => navigate("settings/servers")}
            />
            <NavRow
              icon="download"
              title={t("备份与恢复", "Backup and restore")}
              onClick={() => navigate("settings/backup")}
            />
          </div>
          <div>
            <div className="list-section-title">{t("关于", "About")}</div>
            <div className="nav-list">
              <NavRow
                icon="description"
                title={t("文档", "Documentation")}
                href="https://sing-box.sagernet.org"
              />
              <NavRow
                icon="code"
                title={t("源代码", "Source Code")}
                href="https://github.com/zahuiron/sing-box-manager"
              />
              <NavRow
                icon="description"
                title={t("许可证", "Licenses")}
                href="/licenses/NOTICE.txt"
              />
            </div>
          </div>
          <div className="nav-list">
            <NavRow
              icon="logout"
              title={t("断开连接", "Disconnect")}
              onClick={() =>
                guard(() => {
                  onLogout();
                })
              }
            />
          </div>
        </div>
      </div>
    );
  else if (server)
    content = (
      <div
        className={`page server-page ${tab === "config" || tab === "entry" || tab === "logs" ? "server-page-editor" : ""}`}
      >
        <Header title={server.name} back={() => navigate("overview")}>
          <span className="badge">{stateLabel(remote?.value?.state, t)}</span>
          <IconButton
            icon="sync"
            label={t("刷新状态", "Refresh status")}
            disabled={busy || remote?.loading}
            onClick={() => setRefresh((value) => value + 1)}
          />
          <IconButton
            icon="settings"
            label={t("编辑服务器", "Edit server")}
            disabled={busy}
            onClick={() => guard(() => setEditServer(server))}
          />
        </Header>
        <div className="server-page-address text-mono-caption">
          {server.url}
        </div>
        <ServerTabs
          server={server}
          active={tab === "entry" ? "nodes" : tab}
          navigate={navigate}
        />
        {tab === "logs" ? (
          <LogsView
            key={server.id}
            node={server}
            suspended={suspended}
            embedded
          />
        ) : tab === "nodes" ? (
          <EntriesView
            servers={servers}
            documents={documents}
            scoped={server.id}
            add={addEntry}
            edit={editEntry}
            duplicate={duplicateEntry}
            remove={removeEntry}
            navigate={navigate}
            refresh={() => setDraftRefresh((value) => value + 1)}
            busy={busy}
          />
        ) : tab === "config" || tab === "entry" ? (
          currentWorking ? (
            <DocumentEditor
              key={`${server.id}:${isEntry ? parts.slice(2).join(":") : "config"}`}
              server={server}
              draft={currentWorking}
              schemaState={schemas[server.id] || { loading: true }}
              library={library.data}
              category={isEntry ? "inbounds" : undefined}
              index={isEntry ? Number(parts[3]) : undefined}
              busy={busy}
              onChange={updateContent}
              save={saveWorking}
              check={coreCheck}
              publish={showPublish}
              importRemote={showImport}
              restore={showRestore}
              reload={() =>
                guard(() => {
                  assignWorking(null);
                  setDraftRefresh((value) => value + 1);
                })
              }
              reloadSchema={() => setSchemaRefresh((value) => value + 1)}
              navigate={navigate}
            />
          ) : (
            <div className="empty-state">
              {documents[server.id]?.error ? (
                <>
                  <Notice message={documents[server.id].error || ""} />
                  <button
                    className="button"
                    onClick={() => setDraftRefresh((value) => value + 1)}
                  >
                    {t("重新导入配置", "Import configuration")}
                  </button>
                </>
              ) : (
                <>
                  <Spinner />
                  {t("读取服务器配置…", "Reading server configuration…")}
                </>
              )}
            </div>
          )
        ) : (
          <Overview
            node={server}
            status={remote?.value || null}
            connected={!!remote?.value}
            loading={!!remote?.loading}
            error={remote?.error || ""}
            controlBusy={busy}
            refresh={() => setRefresh((value) => value + 1)}
            control={control}
            navigate={(page) => navigate(`servers/${server.id}/${page}`)}
            embedded
          />
        )}
      </div>
    );
  else
    content = (
      <div className="page">
        <Header title={t("服务器", "Servers")} />
        <button className="button" onClick={() => navigate("overview")}>
          {t("返回总览", "Back to Overview")}
        </button>
      </div>
    );

  return (
    <div className={shell.app} inert={suspended}>
      <div className={shell["mobile-topbar"]}>
        <IconButton
          icon="menu"
          label={t("打开菜单", "Open menu")}
          onClick={() => setNavOpen(true)}
        />
        <span className={shell["mobile-topbar-brand"]}>sing-box manager</span>
      </div>
      {navOpen && mobile && (
        <button
          className={shell["sidebar-scrim"]}
          aria-label={t("关闭菜单", "Close menu")}
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        className={`${shell.sidebar} ${navOpen ? shell.open : ""}`}
        inert={mobile && !navOpen}
        aria-label={t("主导航", "Main navigation")}
        onKeyDown={(event) => {
          if (!mobile || !navOpen || event.key !== "Tab") return;
          const buttons = Array.from(
            sidebar.current!.querySelectorAll<HTMLElement>(
              "button:not(:disabled), [href], select",
            ),
          );
          if (event.shiftKey && document.activeElement === buttons[0]) {
            event.preventDefault();
            buttons.at(-1)?.focus();
          } else if (
            !event.shiftKey &&
            document.activeElement === buttons.at(-1)
          ) {
            event.preventDefault();
            buttons[0]?.focus();
          }
        }}
      >
        <div className={shell["sidebar-brand"]}>
          <span>sing-box manager</span>
          <small className={shell["sidebar-brand-version"]}>
            {session.version}
          </small>
        </div>
        <nav className="main-nav">
          {nav.map(([id, icon, label]) => (
            <button
              key={id}
              className={`${shell["nav-item"]} ${activeNav === id ? shell.active : ""}`}
              aria-current={activeNav === id ? "page" : undefined}
              disabled={busy}
              onClick={() => navigate(id)}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>
        <div
          ref={picker}
          className={shell["server-picker"]}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setPickerOpen(false);
              picker.current
                ?.querySelector<HTMLButtonElement>("[aria-haspopup]")
                ?.focus();
            }
            if (
              pickerOpen &&
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              const options = Array.from(
                picker.current!.querySelectorAll<HTMLButtonElement>(
                  "[role^='menuitem']",
                ),
              );
              const index = options.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              options[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? options.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        options.length) %
                      options.length
              ]?.focus();
            }
          }}
        >
          {pickerOpen && (
            <div
              className="menu open-up"
              role="menu"
              aria-label={t("管理面板", "Management panels")}
            >
              {panels.map((item) => (
                <button
                  className="menu-item"
                  role="menuitemradio"
                  aria-checked={item.url === currentPanel.url}
                  key={item.url}
                  onClick={() => selectPanel(item)}
                >
                  <span className="menu-check">
                    {item.url === currentPanel.url && (
                      <Icon name="check" size={13} />
                    )}
                  </span>
                  {item.name}
                </button>
              ))}
              <div className="menu-divider" />
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => navigate("settings/servers")}
              >
                <span className="menu-check">
                  <Icon name="settings" size={13} />
                </span>
                {t("管理服务器…", "Manage servers…")}
              </button>
            </div>
          )}
          <button
            className={shell["server-picker-button"]}
            onClick={() => setPickerOpen(!pickerOpen)}
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            disabled={busy}
          >
            <span className={shell["server-picker-text"]}>
              <span className={shell["server-picker-line"]}>
                <span
                  className={`state-dot ${shell["server-dot"]} ${suspended ? "" : "good"}`}
                />
                <span className={shell["server-name"]}>
                  {currentPanel.name}
                </span>
              </span>
              <PanelUptime session={session} />
            </span>
            <Icon name="unfold_more" size={13} />
          </button>
        </div>
      </aside>
      <main className={shell.content} inert={mobile && navOpen}>
        {library.error && !libraryRoute && <Notice message={library.error} />}
        {content}
      </main>
      {editServer !== undefined && (
        <ServerDialog
          key={editServer?.id || "new"}
          node={editServer}
          onClose={() => setEditServer(undefined)}
          onSaved={(saved) => {
            setServers((previous) =>
              previous.some((item) => item.id === saved.id)
                ? previous.map((item) =>
                    item.id === saved.id
                      ? { ...saved, configuration: item.configuration }
                      : item,
                  )
                : [...previous, saved],
            );
            setActiveId(saved.id);
            setEditServer(undefined);
            assignWorking(null);
            commitRoute(`servers/${saved.id}`);
            setRefresh((value) => value + 1);
            setDraftRefresh((value) => value + 1);
            setSchemaRefresh((value) => value + 1);
          }}
          onDeleted={(id) => {
            setServers((previous) => previous.filter((item) => item.id !== id));
            setDocuments((previous) => {
              const next = { ...previous };
              delete next[id];
              return next;
            });
            setSchemas((previous) => {
              const next = { ...previous };
              delete next[id];
              return next;
            });
            setStates((previous) => {
              const next = { ...previous };
              delete next[id];
              return next;
            });
            delete schemaCache.current[id];
            if (workingRef.current?.serverId === id) assignWorking(null);
            setEditServer(undefined);
            commitRoute("overview");
            setRefresh((value) => value + 1);
          }}
        />
      )}
      {sortingServers && (
        <ServerOrderDialog
          servers={servers}
          busy={busy}
          onClose={() => setSortingServers(false)}
          save={(ids) =>
            perform(
              async () => {
                listRequest.current?.abort();
                await api("/servers/order", { method: "PUT", json: { ids } });
                const positions = new Map(ids.map((id, index) => [id, index]));
                setServers((previous) =>
                  [...previous].sort(
                    (a, b) =>
                      (positions.get(a.id) ?? ids.length) -
                      (positions.get(b.id) ?? ids.length),
                  ),
                );
                setSortingServers(false);
              },
              t("服务器顺序已保存", "Server order saved"),
            )
          }
        />
      )}
      {createEntry && (
        <CreateEntryDialog
          servers={servers}
          selectedId={createEntry.id}
          onClose={() => setCreateEntry(null)}
          onCreate={beginEntry}
          busy={busy}
        />
      )}
      {pending && (
        <Dialog
          title={t("未保存的修改", "Unsaved changes")}
          onClose={() => setPending(null)}
          busy={busy}
        >
          <p className="dialog-message">
            {t(
              "先保存当前草稿，或放弃本次未保存的修改。",
              "Save the current draft or discard the unsaved edits.",
            )}
          </p>
          <div className="row-actions dialog-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {t("取消", "Cancel")}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => {
                const action = pending;
                if (workingRef.current)
                  assignWorking({
                    ...workingRef.current,
                    content: workingRef.current.original,
                  });
                setPending(null);
                action();
              }}
            >
              {t("放弃修改", "Discard")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                const action = pending;
                const saved = await saveWorking();
                setPending(null);
                if (saved) action();
              }}
            >
              {busy && <Spinner />}
              {t("保存草稿", "Save draft")}
            </button>
          </div>
        </Dialog>
      )}
      {confirmation && (
        <Dialog
          title={confirmation.title}
          onClose={() => setConfirmation(null)}
          busy={busy}
        >
          <p className="dialog-message">{confirmation.message}</p>
          <div className="row-actions dialog-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              {t("取消", "Cancel")}
            </button>
            <button
              className={`button ${confirmation.danger ? "danger" : "primary"}`}
              disabled={busy}
              onClick={() => {
                const action = confirmation.run;
                setConfirmation(null);
                action();
              }}
            >
              {t("确定", "Confirm")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
