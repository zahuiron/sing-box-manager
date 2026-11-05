import { useState } from "react";
import { parseConfig } from "./configuration";
import {
  protocolSchemas,
  resolve,
  validateSchema,
  type Schema,
} from "./schema/schema.mjs";
import { Dialog, Icon, useUI } from "./ui";
import { errorText } from "./api";
import { notify } from "./notifications";
import { Select } from "./vendor/PreferenceControls";
import {
  credentialSchemas,
  maskedConfig,
  matchingTemplates,
  sectionSchema,
  userAuth,
  type LibraryData,
  type ProtocolUser,
} from "./library";

export default function LibraryActions({
  data,
  root,
  kind,
  value,
  busy,
  apply,
}: {
  data: LibraryData | null;
  root: Schema;
  kind: string;
  value: any;
  busy: boolean;
  apply: (value: any) => void;
}) {
  const { t } = useUI();
  const [picker, setPicker] = useState<"template" | "user" | null>(null);
  const isCollection =
    resolve(resolve(root, root).properties?.[kind], root).type === "array";
  const schema = sectionSchema(root, kind, value);
  const credential = value?.type && credentialSchemas().get(value.type);
  let multiple = !!resolve(schema.properties?.users, root).items;
  if (value?.type === "shadowsocks")
    multiple =
      ["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"].includes(
        value.method,
      ) && kind === "inbounds";
  if (value?.type === "shadowtls")
    multiple = value.version === 3 && kind === "inbounds";
  const canUseUser =
    isCollection &&
    credential &&
    (multiple ||
      Object.keys(credential.properties || {}).some(
        (key) =>
          !["name", "username"].includes(key) &&
          Object.hasOwn(schema.properties || {}, key),
      ));
  const disabled = busy || !data;
  function useUsers(users: ProtocolUser[]) {
    if (!credential || !users.length) return;
    try {
      const auth = users.map((user) => userAuth(user, value.type));
      const next = structuredClone(value);
      if (multiple) {
        const values = Array.isArray(next.users) ? [...next.users] : [];
        for (const entry of auth) {
          const index = values.findIndex(
            (item) =>
              (entry.name && item.name === entry.name) ||
              (entry.username && item.username === entry.username) ||
              (entry.uuid && item.uuid === entry.uuid),
          );
          if (index < 0) values.push(entry);
          else values[index] = entry;
        }
        next.users = values;
      } else {
        const fields = Object.fromEntries(
          Object.entries(auth[0]).filter(
            ([key]) =>
              key !== "name" && Object.hasOwn(schema.properties || {}, key),
          ),
        );
        for (const key of Object.keys(credential.properties || {})) {
          if (key !== "name" && Object.hasOwn(schema.properties || {}, key))
            delete next[key];
        }
        if (
          kind === "outbounds" &&
          value.type === "shadowsocks" &&
          ["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"].includes(
            value.method,
          )
        ) {
          const serverKey = String(value.password || "").split(":")[0];
          if (!serverKey)
            throw new Error(
              t(
                "请先填写 Shadowsocks 服务端主密钥",
                "Set the Shadowsocks server key first",
              ),
            );
          fields.password = `${serverKey}:${auth[0].password}`;
        }
        Object.assign(next, fields);
      }
      apply(next);
      setPicker(null);
    } catch (error) {
      notify(errorText(error, t));
    }
  }
  function useTemplate(content: string) {
    try {
      const next = structuredClone(parseConfig(content));
      if (isCollection && value?.tag) next.tag = value.tag;
      const protocols = protocolSchemas(root, kind);
      if (protocols.size && !protocols.has(next.type))
        throw new Error(
          t(
            "目标核心不支持模板中的协议",
            "The target core does not support this template protocol",
          ),
        );
      const issues = validateSchema(
        next,
        sectionSchema(root, kind, next),
        root,
      ).filter((issue) => issue.severity === "error");
      if (issues.length) throw new Error(issues[0].message);
      apply(next);
      setPicker(null);
    } catch (error) {
      notify(errorText(error, t));
    }
  }
  return (
    <span className="library-actions">
      <button
        type="button"
        className="button small"
        disabled={disabled}
        onClick={() => setPicker("template")}
      >
        <Icon name="content_copy" />
        {t("使用模板", "Use template")}
      </button>
      {canUseUser && (
        <button
          type="button"
          className="button small"
          disabled={disabled}
          onClick={() => setPicker("user")}
        >
          <Icon name="person" />
          {t("选择用户模板", "Select user templates")}
        </button>
      )}
      {picker === "template" && data && (
        <TemplatePicker
          data={data}
          kind={kind}
          type={isCollection ? value?.type : undefined}
          close={() => setPicker(null)}
          useTemplate={useTemplate}
        />
      )}
      {picker === "user" && data && (
        <UserPicker
          users={data.users.filter((user) =>
            user.protocols.some((credential) => credential.type === value.type),
          )}
          type={value.type}
          multiple={multiple}
          close={() => setPicker(null)}
          useUsers={useUsers}
        />
      )}
    </span>
  );
}

function TemplatePicker({
  data,
  kind,
  type,
  close,
  useTemplate,
}: {
  data: LibraryData;
  kind: string;
  type?: string;
  close: () => void;
  useTemplate: (content: string) => void;
}) {
  const { t } = useUI();
  const [selected, setSelected] = useState("");
  const templates = matchingTemplates(data, "server", kind, type);
  const template = templates.find((value) => value.id === selected);
  return (
    <Dialog
      title={t("使用服务端模板", "Use server template")}
      className="library-editor-dialog"
      onClose={close}
    >
      {!templates.length ? (
        <p className="hint">
          {t("暂无匹配的服务端模板", "No matching server templates")}
        </p>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor="server-template">
            {t("服务端模板", "Server template")}
          </label>
          <Select
            id="server-template"
            value={selected}
            options={templates.map((template) => ({
              value: template.id,
              label: template.name,
            }))}
            placeholder={t("选择模板", "Choose a template")}
            onChange={setSelected}
          />
        </div>
      )}
      {template && (
        <pre className="schema-preview library-preview">
          {maskedConfig(parseConfig(template.content))}
        </pre>
      )}
      <div className="row-actions dialog-actions">
        <button className="button" onClick={close}>
          {t("取消", "Cancel")}
        </button>
        <button
          className="button primary"
          disabled={!template}
          onClick={() => template && useTemplate(template.content)}
        >
          {t("使用模板", "Use template")}
        </button>
      </div>
    </Dialog>
  );
}

function UserPicker({
  users,
  type,
  multiple,
  close,
  useUsers,
}: {
  users: ProtocolUser[];
  type: string;
  multiple: boolean;
  close: () => void;
  useUsers: (users: ProtocolUser[]) => void;
}) {
  const { t } = useUI();
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <Dialog
      title={`${t("选择用户模板", "Select user templates")} · ${type}`}
      onClose={close}
    >
      {!users.length && (
        <p className="hint">
          {t("暂无匹配的用户模板", "No matching user templates")}
        </p>
      )}
      <div className="library-user-picker">
        {users.map((user) => (
          <label key={user.id} className="library-user-option">
            <input
              type={multiple ? "checkbox" : "radio"}
              name="library-user"
              checked={selected.includes(user.id)}
              onChange={(event) =>
                setSelected((previous) =>
                  multiple
                    ? event.target.checked
                      ? [...previous, user.id]
                      : previous.filter((id) => id !== user.id)
                    : [user.id],
                )
              }
            />
            <span>{user.name}</span>
          </label>
        ))}
      </div>
      <div className="row-actions dialog-actions">
        <button className="button" onClick={close}>
          {t("取消", "Cancel")}
        </button>
        <button
          className="button primary"
          disabled={!selected.length}
          onClick={() =>
            useUsers(users.filter((user) => selected.includes(user.id)))
          }
        >
          {t("填入草稿", "Insert into draft")}
        </button>
      </div>
    </Dialog>
  );
}
