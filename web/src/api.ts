export interface Session {
  version: string;
  started_at: string;
  uptime_seconds: number;
}
export interface ServerRecord {
  id: string;
  name: string;
  url: string;
  ca_pem?: string;
  configuration?: {
    revision: number;
    published_revision: number;
    counts?: Record<string, number>;
    updated_at: string;
  };
}
export interface ServerInput extends Omit<
  ServerRecord,
  "id" | "configuration"
> {
  id?: string;
  token: string;
}
export interface Status {
  state: string;
  core_version: string;
  agent_version: string;
  driver: string;
  environment?: string;
  api_version: number;
}
export interface Configuration {
  content: string;
  etag: string;
}
export interface ManagedDraft {
  content: string;
  published_content: string;
  revision: number;
  published_revision: number;
  remote_etag: string;
  source_url: string;
  updated_at: string;
}
export interface WorkingDraft extends ManagedDraft {
  serverId: string;
  original: string;
}
export interface SaveResult {
  environment?: string;
  etag: string;
  applied: boolean;
  state?: string;
  rolled_back?: boolean;
}

export interface PanelTarget {
  url: string;
  secret: string;
}
let target: PanelTarget = { url: location.origin, secret: "" };
export function setPanelTarget(value: PanelTarget) {
  target = { url: value.url, secret: value.secret };
}
export function panelOrigin() {
  return target.url;
}

export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public result?: SaveResult,
  ) {
    super(message);
  }
}

export function apiFetch(
  path: string,
  options: RequestInit & { json?: unknown } = {},
  panel: PanelTarget = target,
): Promise<Response> {
  const { json, ...init } = options;
  const headers = new Headers(init.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (panel.secret) headers.set("Authorization", `Bearer ${panel.secret}`);
  return fetch(`${panel.url}/api${path}`, {
    ...init,
    headers,
    body: json === undefined ? init.body : JSON.stringify(json),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
}

export async function api<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const panel = target;
  const response = await apiFetch(path, options, panel);
  return readResponse<T>(response, panel === target);
}

export async function connectPanel(panel: PanelTarget, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(8000);
  const response = await apiFetch(
    "/session",
    {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    },
    panel,
  );
  const session = await readResponse<Session>(response, false);
  if (
    !session ||
    typeof session.version !== "string" ||
    typeof session.started_at !== "string" ||
    typeof session.uptime_seconds !== "number"
  )
    throw new Error(
      "不是有效的 sing-box manager 面板 / Not a valid sing-box manager panel",
    );
  return session;
}

export async function readResponse<T>(
  response: Response,
  notifyUnauthorized = true,
): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error?.code || "request_failed";
    if (
      notifyUnauthorized &&
      response.status === 401 &&
      code === "unauthorized"
    )
      window.dispatchEvent(new Event("sbm:unauthorized"));
    throw new APIError(
      response.status,
      code,
      body?.error?.message || `HTTP ${response.status}`,
      body?.result,
    );
  }
  return body as T;
}

export function agent<T>(
  id: string,
  path: string,
  options?: RequestInit & { json?: unknown },
) {
  return api<T>(`/servers/${encodeURIComponent(id)}/agent/${path}`, options);
}

export const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

export function errorText(
  error: unknown,
  t: (zh: string, en: string) => string,
): string {
  if (!(error instanceof Error)) return t("请求失败", "Request failed");
  if (error instanceof APIError) {
    const messages: Record<string, [string, string]> = {
      connection_failed: [
        "无法连接 Agent，请检查地址、端口和网络",
        "Cannot connect to Agent. Check address, port and network",
      ],
      certificate_error: [
        "证书验证失败，请检查域名、有效期或受信 CA",
        "Certificate verification failed. Check hostname, expiry or trusted CA",
      ],
      unauthorized: [
        "面板密钥错误，请检查后重新连接",
        "Invalid panel secret. Check it and reconnect",
      ],
      agent_unauthorized: [
        "Agent 拒绝了服务器 Token，请检查接入设置",
        "Agent rejected the server token. Check server settings",
      ],
      config_conflict: [
        "远端配置已改变，未覆盖。请先复制草稿中的修改，再导入远端并合并",
        "The remote configuration changed and was not overwritten. Copy your draft edits before importing and merging the remote file",
      ],
      draft_conflict: [
        "草稿已在其他页面更新，请重新读取后合并修改",
        "The draft changed in another page. Reload it and merge your changes",
      ],
      source_changed: [
        "服务器地址已改变，请导入该服务器的当前配置",
        "The server address changed. Import its current configuration",
      ],
      schema_unavailable: [
        "目标核心未提供 Schema，可升级核心或使用 JSON 编辑",
        "This core cannot provide a schema. Upgrade it or use the JSON editor",
      ],
      draft_required: [
        "管理流程已更新，请刷新页面后保存草稿并发布",
        "The workflow changed. Refresh the panel, save a draft and publish it",
      ],
      publish_record_failed: [
        "远端已接受配置，但面板记录保存失败。请先导入远端确认结果",
        "The server accepted the configuration, but the panel could not save its record. Import the remote file to confirm the result",
      ],
      apply_failed: [
        "应用失败，已恢复原配置与服务；草稿仍保留",
        "Apply failed. The previous configuration and service were restored; the draft is retained",
      ],
      service_busy: [
        "服务器正在执行其他操作，请稍后刷新状态",
        "The server is busy. Refresh its status shortly",
      ],
      server_order_conflict: [
        "服务器列表已改变，请刷新后重新排序",
        "The server list changed. Refresh it before reordering",
      ],
      server_order_failed: [
        "服务器顺序保存失败，请重试",
        "Could not save server order. Try again",
      ],
      library_conflict: [
        "用户、模板或订阅已在其他页面更新，请复制当前修改，刷新后重试",
        "The library changed in another page. Copy your edits, refresh and retry",
      ],
      library_unavailable: [
        "无法读取用户、模板和订阅",
        "Cannot read users, templates and subscriptions",
      ],
      library_save_failed: [
        "用户、模板或订阅保存失败，请重试",
        "Could not save the library. Try again",
      ],
      invalid_library: [
        "用户、模板或订阅数据无效，请检查名称、协议和配置",
        "Invalid library data. Check names, protocols and configuration",
      ],
      logs_unavailable: [
        "日志源不可用，请检查服务器的日志设置",
        "Log source unavailable. Check the server's log settings",
      ],
      backup_busy: [
        "正在处理其他备份或恢复，请稍后重试",
        "Another backup or restore is running. Try again shortly",
      ],
      backup_failed: [
        "备份导出失败，数据无法完整读取或超过 128 MiB",
        "Could not export the complete backup, or it exceeds 128 MiB",
      ],
      restore_busy: [
        "面板仍有操作正在执行，请稍后重试",
        "Panel requests are still running. Try again shortly",
      ],
      restore_failed: [
        "恢复失败，已保留原面板数据",
        "Restore failed. Previous panel data was retained",
      ],
      restore_recovery_required: [
        "恢复未完成，请重启面板恢复原数据",
        "Restore is incomplete. Restart the panel to recover the previous data",
      ],
    };
    if (messages[error.code]) return t(...messages[error.code]);
  }
  if (error.name === "TimeoutError")
    return t(
      "连接超时，请检查地址和网络",
      "Connection timed out. Check the URL and network",
    );
  if (error instanceof TypeError)
    return t(
      "无法连接面板，请检查地址、证书和网络",
      "Cannot connect to panel. Check the URL, certificate and network",
    );
  return error.message;
}
