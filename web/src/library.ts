import { useEffect, useRef, useState } from "react";
import { api, errorText, isAbort } from "./api";
import { categories, parseConfig } from "./configuration";
import {
  effectiveSchema,
  protocolSchemas,
  resolve,
  validateSchema,
  type Schema,
} from "./schema/schema.mjs";
import { useUI } from "./ui";

export interface Credential {
  type: string;
  auth: Record<string, any>;
}
export interface ProtocolUser {
  id: string;
  name: string;
  protocols: Credential[];
}
export type TemplateTarget = "client" | "server";
export interface ConfigTemplate {
  id: string;
  name: string;
  target: TemplateTarget;
  kind: string;
  content: string;
}
export interface SubscriptionNode {
  server_id: string;
  tag: string;
}
export interface SubscriptionEndpoint extends SubscriptionNode {
  name?: string;
  address: string;
  port: number;
  server_name: string;
}
export interface SubscriptionGroup {
  id?: string;
  type: "selector" | "urltest" | "direct";
  tag: string;
  members?: SubscriptionMember[] | null;
}
export interface SubscriptionMember {
  kind: "node" | "group" | "direct";
  server_id?: string;
  tag?: string;
  group_id?: string;
}
export interface SubscriptionDirect {
  enabled: boolean;
  tag: string;
}
export interface Subscription {
  id: string;
  name: string;
  content?: string;
  templates?: ConfigTemplate[];
  user_id: string;
  scope: "all" | "servers" | "nodes";
  servers: string[];
  nodes: SubscriptionNode[];
  endpoints: SubscriptionEndpoint[];
  groups: SubscriptionGroup[];
  direct?: SubscriptionDirect;
  token: string;
  reset_token?: boolean;
}
export interface LibraryData {
  revision: number;
  users: ProtocolUser[];
  templates: ConfigTemplate[];
  subscriptions: Subscription[];
}
export type LibrarySave = (
  next: LibraryData,
  message: string,
) => Promise<boolean>;
export type LibraryConfirm = (
  title: string,
  message: string,
  run: () => void,
) => void;

export function useLibrary(enabled: boolean, suspended: boolean) {
  const { t } = useUI();
  const [data, setData] = useState<LibraryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const loaded = useRef(-1);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled || suspended || loaded.current === refresh) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    api<LibraryData>("/library", { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        loaded.current = refresh;
        setData(value);
      })
      .catch((failure) => {
        if (!isAbort(failure)) setError(errorText(failure, t));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, suspended, refresh]);
  async function persist(next: LibraryData) {
    request.current?.abort();
    const value = await api<LibraryData>("/library", {
      method: "PUT",
      json: next,
    });
    loaded.current = refresh;
    setData(value);
    setLoading(false);
    setError("");
  }
  return {
    data,
    loading,
    error,
    persist,
    reload: () => setRefresh((value) => value + 1),
  };
}

export function newID() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function credentialSchema(
  identity: "name" | "username",
  fields: Record<string, Schema>,
  required: string[],
): Schema {
  return {
    type: "object",
    properties: {
      [identity]: { type: "string", minLength: 1, title: "用户名" },
      ...fields,
    },
    required: [identity, ...required],
    additionalProperties: false,
  };
}

const password = { type: "string", minLength: 1 };
const uuid = { type: "string", minLength: 1, format: "uuid" };
const namedPassword = credentialSchema("name", { password }, ["password"]);
const basicAuth = credentialSchema(
  "username",
  { password: { type: "string" } },
  [],
);
const credentials = new Map<string, Schema>([
  ["anytls", namedPassword],
  ["http", basicAuth],
  [
    "hysteria",
    credentialSchema(
      "name",
      {
        auth: {
          anyOf: [
            { type: "string" },
            {
              type: "array",
              items: { type: "integer", minimum: 0, maximum: 255 },
            },
          ],
        },
        auth_str: { type: "string" },
      },
      [],
    ),
  ],
  ["hysteria2", namedPassword],
  ["mixed", basicAuth],
  ["naive", basicAuth],
  ["shadowsocks", namedPassword],
  ["shadowtls", namedPassword],
  ["snell", credentialSchema("name", { userkey: password }, ["userkey"])],
  ["socks", basicAuth],
  ["trojan", namedPassword],
  [
    "tuic",
    credentialSchema("name", { uuid, password: { type: "string" } }, ["uuid"]),
  ],
  [
    "vless",
    credentialSchema(
      "name",
      { uuid, flow: { type: "string", enum: ["", "xtls-rprx-vision"] } },
      ["uuid"],
    ),
  ],
  [
    "vmess",
    credentialSchema(
      "name",
      { uuid, alterId: { type: "integer", minimum: 0 } },
      ["uuid"],
    ),
  ],
]);

export function credentialSchemas() {
  return credentials;
}

let templateSchema: Promise<Schema> | undefined;
export function loadTemplateSchema(): Promise<Schema> {
  return (templateSchema ??= import("./schema/sing-box.schema.json?raw")
    .then((module) => JSON.parse(module.default))
    .catch((error) => {
      templateSchema = undefined;
      throw error;
    }));
}

export function initialAuth(schema: Schema): Record<string, any> {
  const value: Record<string, any> = {};
  for (const key of schema.required || []) {
    const type = schema.properties?.[key]?.type;
    value[key] =
      type === "integer" || type === "number"
        ? 0
        : type === "boolean"
          ? false
          : type === "array"
            ? []
            : "";
  }
  if (schema.properties?.auth_str) value.auth_str = "";
  if (schema.properties?.password && value.password === undefined)
    value.password = "";
  return value;
}

export function credentialIssues(
  value: Record<string, any>,
  schema: Schema,
  root: Schema,
) {
  const issues = validateSchema(value, schema, root);
  if (
    schema.properties?.auth &&
    schema.properties?.auth_str &&
    !value.auth?.length &&
    !value.auth_str
  )
    issues.push({
      path: "/auth_str",
      severity: "error",
      message: "需要填写 auth 或 auth_str / Set auth or auth_str",
    });
  return issues;
}

export function userAuth(user: ProtocolUser, type: string) {
  const credential = user.protocols.find((value) => value.type === type);
  const schema = credentialSchemas().get(type);
  if (!credential || !schema)
    throw new Error("当前协议没有可用认证 / No credentials for this protocol");
  const auth = Object.fromEntries(
    Object.keys(schema.properties || {})
      .filter((key) => Object.hasOwn(credential.auth, key))
      .map((key) => [key, credential.auth[key]]),
  );
  const issues = credentialIssues(auth, schema, schema);
  if (issues.some((issue) => issue.severity === "error"))
    throw new Error(`${user.name} · ${issues[0].message}`);
  return auth;
}

export function templateKinds() {
  return [
    "config",
    ...categories,
    "log",
    "dns",
    "ntp",
    "certificate",
    "certificate_providers",
    "http_clients",
    "network_namespaces",
    "route",
    "experimental",
  ];
}

export function sectionSchema(root: Schema, kind: string, value: any): Schema {
  if (kind === "config") return root;
  const property = resolve(resolve(root, root).properties?.[kind], root);
  if (property.type !== "array") return property;
  const protocols = protocolSchemas(root, kind);
  if (!protocols.size)
    return effectiveSchema(property.items || {}, root, value);
  const node = protocols.get(value?.type) || { type: "object", properties: {} };
  return {
    ...node,
    required: [...new Set([...(node.required || []), "type"])],
    properties: {
      ...node.properties,
      type: { type: "string", enum: [...protocols.keys()] },
    },
  };
}

export function templateKindAt(root: Schema, path: (string | number)[]) {
  if (!path.length) return "config";
  const kind = String(path[0]);
  const property = resolve(resolve(root, root).properties?.[kind], root);
  if (path.length === 1 && (property.type === "object" || property.properties))
    return kind;
  if (
    path.length === 2 &&
    typeof path[1] === "number" &&
    property.type === "array"
  )
    return kind;
  return null;
}

export function matchingTemplates(
  data: LibraryData,
  target: TemplateTarget,
  kind: string,
  type?: string,
) {
  return data.templates.filter((template) => {
    if ((template.target || "server") !== target || template.kind !== kind)
      return false;
    try {
      const config = parseConfig(template.content);
      return !type || config.type === type;
    } catch {
      return false;
    }
  });
}

export function maskedConfig(value: any) {
  return JSON.stringify(
    value,
    (key, item) =>
      /password|secret|token|private_key|account_key|client_key|api_key|access_key|(^|_)psk$|^key$|^uuid$|^auth(_str)?$|^userkey$/.test(
        key,
      ) ||
      (typeof item === "string" &&
        /-----BEGIN [^-]*PRIVATE KEY-----/.test(item))
        ? "••••••••"
        : item,
    2,
  );
}
