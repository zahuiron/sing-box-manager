import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { configText, parseConfig } from "./configuration";
import { validateSchema, type Schema } from "./schema/schema.mjs";
import { Dialog, Icon, IconButton, Spinner, useUI } from "./ui";
import { Header } from "./views";
import { Select } from "./vendor/PreferenceControls";
import { Notice, notify } from "./notifications";
import {
  credentialIssues,
  credentialSchemas,
  initialAuth,
  loadTemplateSchema,
  newID,
  sectionSchema,
  templateKinds,
  type Credential,
  type ConfigTemplate,
  type LibraryConfirm,
  type LibraryData,
  type LibrarySave,
  type ProtocolUser,
  type TemplateTarget,
} from "./library";

const FieldEditor = lazy(() => import("./FieldEditor"));
const Editor = lazy(() => import("./Editor"));

export interface LibraryViewProps {
  data: LibraryData | null;
  loading: boolean;
  error: string;
  busy: boolean;
  reload: () => void;
  save: LibrarySave;
  confirm: LibraryConfirm;
}

function KindName({ kind }: { kind: string }) {
  const { t } = useUI();
  return <>{kind === "config" ? t("完整配置", "Full configuration") : kind}</>;
}

function TargetName({ target }: { target: TemplateTarget }) {
  const { t } = useUI();
  return (
    <>
      {target === "client"
        ? t("客户端模板", "Client templates")
        : t("服务端模板", "Server templates")}
    </>
  );
}

export function LibraryPage({
  title,
  create,
  children,
  ...props
}: LibraryViewProps & {
  title: string;
  create: () => void;
  children: ReactNode;
}) {
  const { t } = useUI();
  const disabled = props.busy || props.loading || !props.data;
  return (
    <div className="page">
      <Header title={title}>
        <IconButton
          icon="sync"
          label={t("刷新", "Refresh")}
          disabled={props.busy || props.loading}
          onClick={props.reload}
        />
        <button className="button primary" disabled={disabled} onClick={create}>
          <Icon name="add" />
          {t("创建", "Create")}
        </button>
      </Header>
      {props.error && <Notice message={props.error} />}
      {!props.data ? (
        <div className="empty-state">
          {props.loading ? (
            <Spinner />
          ) : (
            <button className="button" onClick={props.reload}>
              {t("重新读取", "Reload")}
            </button>
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function UserTemplatesView({
  tabs,
  ...props
}: LibraryViewProps & { tabs: ReactNode }) {
  const { t } = useUI();
  const { data, busy, save, confirm } = props;
  const [nameDialog, setNameDialog] = useState<
    ProtocolUser | null | undefined
  >();
  const [protocolDialog, setProtocolDialog] = useState<{
    user: ProtocolUser;
    credential?: Credential;
  } | null>(null);
  const disabled = busy || props.loading;
  function saveUser(user: ProtocolUser) {
    if (!data) return Promise.resolve(false);
    if (
      data.users.some(
        (value) => value.name === user.name && value.id !== user.id,
      )
    ) {
      notify(t("用户模板已存在", "User template already exists"));
      return Promise.resolve(false);
    }
    return save(
      {
        ...data,
        users: data.users.some((value) => value.id === user.id)
          ? data.users.map((value) => (value.id === user.id ? user : value))
          : [...data.users, user],
      },
      t("用户模板已保存", "User template saved"),
    );
  }
  return (
    <LibraryPage
      {...props}
      title={t("模板", "Templates")}
      create={() => setNameDialog(null)}
    >
      {tabs}
      {!data?.users.length && (
        <div className="empty-state">
          {t("尚未创建用户模板", "No user templates created")}
        </div>
      )}
      <div className="library-user-grid">
        {data?.users.map((user) => (
          <section className="card library-user-card" key={user.id}>
            <div className="library-user-heading">
              <div className="library-user-title">
                <strong>{user.name}</strong>
                <span className="hint">
                  {user.protocols.length} {t("个协议", "protocols")}
                </span>
              </div>
              <div className="library-actions">
                <IconButton
                  icon="tune"
                  label={t("修改用户模板", "Rename user template")}
                  disabled={disabled}
                  onClick={() => setNameDialog(user)}
                />
                <IconButton
                  icon="delete"
                  label={t("删除用户模板", "Delete user template")}
                  disabled={disabled}
                  onClick={() =>
                    confirm(
                      t("删除用户模板", "Delete user template"),
                      `${user.name} · ${t("已填入配置的认证保持原值。", "Credentials already inserted in configurations keep their values.")}`,
                      () => {
                        void save(
                          {
                            ...data!,
                            users: data!.users.filter(
                              (value) => value.id !== user.id,
                            ),
                          },
                          t("用户模板已删除", "User template deleted"),
                        );
                      },
                    )
                  }
                />
              </div>
            </div>
            <div className="library-user-protocols">
              {!user.protocols.length && (
                <p className="hint library-user-empty">
                  {t("尚未添加协议", "No protocols added")}
                </p>
              )}
              {user.protocols.map((credential) => {
                const identity =
                  credential.auth.name || credential.auth.username;
                return (
                  <div className="library-user-protocol" key={credential.type}>
                    <div className="library-user-credential">
                      <span className="library-user-protocol-name">
                        {credential.type}
                      </span>
                      {typeof identity === "string" && identity && (
                        <span className="hint">{identity}</span>
                      )}
                    </div>
                    <div className="library-actions">
                      <IconButton
                        icon="tune"
                        label={t("编辑认证", "Edit credentials")}
                        disabled={disabled}
                        onClick={() => setProtocolDialog({ user, credential })}
                      />
                      <IconButton
                        icon="delete"
                        label={t("删除协议", "Delete protocol")}
                        disabled={disabled}
                        onClick={() =>
                          confirm(
                            t("删除协议认证", "Delete protocol credentials"),
                            `${user.name} · ${credential.type}`,
                            () => {
                              void saveUser({
                                ...user,
                                protocols: user.protocols.filter(
                                  (value) => value.type !== credential.type,
                                ),
                              });
                            },
                          )
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              className="button small library-user-add"
              disabled={disabled}
              onClick={() => setProtocolDialog({ user })}
            >
              <Icon name="add" />
              {t("添加协议", "Add protocol")}
            </button>
          </section>
        ))}
      </div>
      {nameDialog !== undefined && (
        <UserNameDialog
          user={nameDialog}
          busy={busy}
          onClose={() => setNameDialog(undefined)}
          save={async (user) => {
            const ok = await saveUser(user);
            if (ok) setNameDialog(undefined);
            return ok;
          }}
        />
      )}
      {protocolDialog && (
        <CredentialDialog
          user={protocolDialog.user}
          credential={protocolDialog.credential}
          busy={busy}
          onClose={() => setProtocolDialog(null)}
          save={async (credential) => {
            const user = protocolDialog.user;
            const next = {
              ...user,
              protocols: user.protocols.some(
                (value) => value.type === credential.type,
              )
                ? user.protocols.map((value) =>
                    value.type === credential.type ? credential : value,
                  )
                : [...user.protocols, credential],
            };
            const ok = await saveUser(next);
            if (ok) setProtocolDialog(null);
            return ok;
          }}
        />
      )}
    </LibraryPage>
  );
}

function UserNameDialog({
  user,
  busy,
  onClose,
  save,
}: {
  user: ProtocolUser | null;
  busy: boolean;
  onClose: () => void;
  save: (user: ProtocolUser) => Promise<boolean>;
}) {
  const { t } = useUI();
  const [name, setName] = useState(user?.name || "");
  return (
    <Dialog
      title={
        user
          ? t("修改用户模板", "Rename user template")
          : t("创建用户模板", "Create user template")
      }
      busy={busy}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && name.trim())
            void save({
              id: user?.id || newID(),
              name: name.trim(),
              protocols: user?.protocols || [],
            });
        }}
      >
        <label className="field">
          <span className="field-label">{t("用户", "User")}</span>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={128}
            autoFocus
            disabled={busy}
          />
        </label>
        <DialogActions busy={busy} close={onClose} disabled={!name.trim()} />
      </form>
    </Dialog>
  );
}

function CredentialDialog({
  user,
  credential,
  busy,
  onClose,
  save,
}: {
  user: ProtocolUser;
  credential?: Credential;
  busy: boolean;
  onClose: () => void;
  save: (credential: Credential) => Promise<boolean>;
}) {
  const { t } = useUI();
  const catalogue = credentialSchemas();
  const types = [...catalogue.keys()].filter(
    (type) =>
      credential?.type === type ||
      !user.protocols.some((value) => value.type === type),
  );
  const [type, setType] = useState(credential?.type || types[0] || "");
  const schema = catalogue.get(type) || null;
  const [auth, setAuth] = useState(() => ({
    ...(schema ? initialAuth(schema) : {}),
    ...structuredClone(credential?.auth || {}),
  }));
  const issues = schema ? credentialIssues(auth, schema, schema) : [];
  const invalid = !schema || issues.some((issue) => issue.severity === "error");
  return (
    <Dialog
      title={`${user.name} · ${t("协议认证", "Protocol credentials")}`}
      className="library-editor-dialog"
      busy={busy}
      onClose={onClose}
    >
      <label className="field">
        <span className="field-label">{t("协议", "Protocol")}</span>
        <select
          className="select"
          value={type}
          disabled={busy || !!credential}
          onChange={(event) => {
            setType(event.target.value);
            setAuth(initialAuth(catalogue.get(event.target.value)!));
          }}
        >
          {!types.length && (
            <option value="">
              {t("没有可添加的协议", "No more protocols available")}
            </option>
          )}
          {credential && !catalogue.has(credential.type) && (
            <option value={credential.type}>{credential.type}</option>
          )}
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      {schema ? (
        <>
          {schema.properties?.uuid && (
            <button
              className="button small"
              disabled={busy}
              onClick={() =>
                setAuth((previous) => ({ ...previous, uuid: newID() }))
              }
            >
              {t("生成 UUID", "Generate UUID")}
            </button>
          )}
          <Suspense fallback={<Spinner />}>
            <FieldEditor
              key={type}
              value={auth}
              schema={schema}
              root={schema}
              issues={issues}
              disabled={busy}
              onChange={setAuth}
            />
          </Suspense>
        </>
      ) : (
        <p className="hint">
          {t(
            "不支持此协议的认证定义。",
            "Credentials are not defined for this protocol.",
          )}
        </p>
      )}
      <DialogActions
        busy={busy}
        close={onClose}
        disabled={invalid}
        save={() => {
          if (!invalid && !busy) void save({ type, auth });
        }}
      />
    </Dialog>
  );
}

export function TemplatesView({
  category,
  onCategoryChange,
  ...props
}: LibraryViewProps & {
  category: TemplateTarget | "users";
  onCategoryChange: (category: TemplateTarget | "users") => void;
}) {
  const { t } = useUI();
  const { data, save, busy, confirm } = props;
  const [editing, setEditing] = useState<ConfigTemplate | null | undefined>();
  const tabs = (
    <div
      className="segmented template-tabs"
      role="group"
      aria-label={t("模板类型", "Template type")}
    >
      {(["server", "client", "users"] as const).map((value) => (
        <button
          type="button"
          key={value}
          className={category === value ? "active" : ""}
          aria-pressed={category === value}
          disabled={busy || props.loading}
          onClick={() => onCategoryChange(value)}
        >
          {value === "users" ? (
            t("用户模板", "User templates")
          ) : (
            <TargetName target={value} />
          )}
        </button>
      ))}
    </div>
  );
  if (category === "users") return <UserTemplatesView {...props} tabs={tabs} />;
  const target = category;
  const templates =
    data?.templates.filter(
      (template) => (template.target || "server") === target,
    ) || [];
  return (
    <LibraryPage
      {...props}
      title={t("模板", "Templates")}
      create={() => setEditing(null)}
    >
      {tabs}
      {!templates.length && (
        <div className="empty-state">
          {t("尚未创建模板", "No templates created")}
        </div>
      )}
      <div className="fleet-grid">
        {templates.map((template) => {
          let protocol = "";
          try {
            protocol = parseConfig(template.content).type || "";
          } catch {}
          return (
            <section className="card" key={template.id}>
              <div className="library-card-heading">
                <strong>{template.name}</strong>
                <span className="badge">
                  <KindName kind={template.kind} />
                </span>
              </div>
              {protocol && <p className="hint text-mono-caption">{protocol}</p>}
              <div className="library-actions">
                <button
                  className="button"
                  disabled={busy || props.loading}
                  onClick={() => setEditing(template)}
                >
                  {t("编辑", "Edit")}
                </button>
                <IconButton
                  icon="delete"
                  label={t("删除模板", "Delete template")}
                  disabled={busy || props.loading}
                  onClick={() =>
                    confirm(
                      t("删除模板", "Delete template"),
                      template.name,
                      () => {
                        void save(
                          {
                            ...data!,
                            templates: data!.templates.filter(
                              (value) => value.id !== template.id,
                            ),
                          },
                          t("模板已删除", "Template deleted"),
                        );
                      },
                    )
                  }
                />
              </div>
            </section>
          );
        })}
      </div>
      {editing !== undefined && data && (
        <TemplateDialog
          template={editing}
          defaultTarget={target}
          busy={busy}
          onClose={() => setEditing(undefined)}
          save={async (template) => {
            const templates = data.templates.some(
              (value) => value.id === template.id,
            )
              ? data.templates.map((value) =>
                  value.id === template.id ? template : value,
                )
              : [...data.templates, template];
            const ok = await save(
              { ...data, templates },
              t("模板已保存", "Template saved"),
            );
            if (ok) {
              onCategoryChange(template.target);
              setEditing(undefined);
            }
            return ok;
          }}
        />
      )}
    </LibraryPage>
  );
}

function TemplateDialog({
  template,
  defaultTarget,
  busy,
  onClose,
  save,
}: {
  template: ConfigTemplate | null;
  defaultTarget: TemplateTarget;
  busy: boolean;
  onClose: () => void;
  save: (template: ConfigTemplate) => Promise<boolean>;
}) {
  const { t } = useUI();
  const [name, setName] = useState(template?.name || "");
  const [target, setTarget] = useState<TemplateTarget>(
    template?.target || defaultTarget,
  );
  const [kind, setKind] = useState(
    template?.kind || (defaultTarget === "client" ? "config" : "outbounds"),
  );
  const [content, setContent] = useState(template?.content || "{}\n");
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [schemaRoot, setSchemaRoot] = useState<Schema | null>(null);
  const [schemaError, setSchemaError] = useState("");
  useEffect(() => {
    let active = true;
    loadTemplateSchema()
      .then((root) => {
        if (active) setSchemaRoot(root);
      })
      .catch(() => {
        if (active)
          setSchemaError(
            t(
              "无法加载内置字段定义，请刷新页面",
              "Cannot load built-in fields. Refresh the page",
            ),
          );
      });
    return () => {
      active = false;
    };
  }, []);
  const kinds = templateKinds();
  let value: Record<string, any> | null = null,
    error = "";
  try {
    value = parseConfig(content);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const schema = schemaRoot && sectionSchema(schemaRoot, kind, value);
  const issues =
    value && schema && schemaRoot
      ? validateSchema(value, schema, schemaRoot)
      : [];
  const invalid =
    !name.trim() ||
    !value ||
    issues.some((issue) => issue.severity === "error");
  function submit() {
    if (!busy && !invalid)
      void save({
        id: template?.id || newID(),
        name: name.trim(),
        target,
        kind,
        content,
      });
  }
  return (
    <Dialog
      title={
        template
          ? t("编辑模板", "Edit template")
          : t("创建模板", "Create template")
      }
      className="library-editor-dialog"
      busy={busy}
      onClose={onClose}
    >
      <fieldset disabled={busy}>
        <label className="field">
          <span className="field-label">{t("名称", "Name")}</span>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={128}
          />
        </label>
        <div className="field">
          <label className="field-label" htmlFor="template-target">
            {t("模板类型", "Template type")}
          </label>
          <Select
            id="template-target"
            value={target}
            disabled={busy}
            options={(["server", "client"] as const).map((value) => ({
              value,
              label: <TargetName target={value} />,
            }))}
            onChange={setTarget}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="template-kind">
            {t("配置类别", "Configuration category")}
          </label>
          <Select
            id="template-kind"
            value={kind}
            disabled={busy}
            options={(kinds.includes(kind) ? kinds : [kind, ...kinds]).map(
              (value) => ({ value, label: <KindName kind={value} /> }),
            )}
            onChange={(value) => {
              setKind(value);
              setContent("{}\n");
            }}
          />
        </div>
        <div className="segmented">
          <button
            type="button"
            className={mode === "fields" ? "active" : ""}
            onClick={() => setMode("fields")}
          >
            {t("字段", "Fields")}
          </button>
          <button
            type="button"
            className={mode === "json" ? "active" : ""}
            onClick={() => setMode("json")}
          >
            JSON
          </button>
        </div>
      </fieldset>
      {schemaError && <Notice message={schemaError} />}
      <Suspense fallback={<Spinner />}>
        {mode === "fields" && !schemaRoot && !schemaError ? (
          <Spinner />
        ) : mode === "fields" && value && schema && schemaRoot ? (
          <FieldEditor
            key={kind}
            value={value}
            schema={schema}
            root={schemaRoot}
            issues={issues}
            disabled={busy}
            onChange={(value) => setContent(configText(value))}
          />
        ) : (
          <div className="library-json-editor">
            <Editor
              value={content}
              onChange={setContent}
              onSave={submit}
              disabled={busy}
              editorRef={null}
            />
          </div>
        )}
      </Suspense>
      {(error || issues.length > 0) && (
        <p className="field-error">{error || issues[0].message}</p>
      )}
      <DialogActions
        busy={busy}
        close={onClose}
        disabled={invalid}
        save={submit}
      />
    </Dialog>
  );
}

function DialogActions({
  busy,
  close,
  save,
  disabled,
}: {
  busy: boolean;
  close: () => void;
  save?: () => void;
  disabled?: boolean;
}) {
  const { t } = useUI();
  return (
    <div className="row-actions dialog-actions">
      <button type="button" className="button" disabled={busy} onClick={close}>
        {t("取消", "Cancel")}
      </button>
      <button
        type={save ? "button" : "submit"}
        className="button primary"
        disabled={busy || disabled}
        onClick={save}
      >
        {busy && <Spinner />}
        {t("保存", "Save")}
      </button>
    </div>
  );
}
