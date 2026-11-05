import { useEffect, useRef, useState } from "react";
import { api, errorText, isAbort } from "./api";
import { copyText, downloadText } from "./browser";
import { LibraryPage, type LibraryViewProps } from "./LibraryViews";
import SubscriptionNodes from "./SubscriptionNodes";
import {
  newID,
  type ConfigTemplate,
  type LibraryData,
  type Subscription,
} from "./library";
import { Notice, notify } from "./notifications";
import { Dialog, Icon, IconButton, Spinner, useUI } from "./ui";
import { Select } from "./vendor/PreferenceControls";
import {
  generateSubscription,
  editableSubscription,
  selectedSubscriptionNodes,
  subscriptionMessage,
  subscriptionURL,
  type SubscriptionResult,
  type SubscriptionSource,
} from "./subscriptions";

interface PreviewState {
  profile: Subscription;
  result?: SubscriptionResult;
  failure?: string;
}

function download(profile: Subscription, result: SubscriptionResult) {
  if (result.content)
    downloadText(
      result.content,
      `${profile.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "config"}.json`,
      "application/json;charset=utf-8",
    );
}

export default function SubscriptionsView(
  props: LibraryViewProps & { suspended: boolean },
) {
  const { t } = useUI();
  const { data, save, confirm } = props;
  const [editing, setEditing] = useState<Subscription | undefined>();
  const [sources, setSources] = useState<SubscriptionSource[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [generating, setGenerating] = useState(false);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    if (props.suspended) return;
    const controller = new AbortController();
    setSourceLoading(true);
    setSourceError("");
    api<SubscriptionSource[]>("/subscriptions/sources", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSources(value);
      })
      .catch((error) => {
        if (!isAbort(error)) setSourceError(errorText(error, t));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [refresh, props.suspended]);
  useEffect(() => () => request.current?.abort(), []);
  const busy = props.busy || generating;
  const profiles = data?.subscriptions || [];
  function edit(profile: Subscription) {
    if (sourceLoading || sourceError) {
      notify(
        sourceError ||
          t("正在读取节点，请稍候", "Loading nodes. Try again shortly"),
      );
      return;
    }
    setEditing(profile);
  }
  function create() {
    edit({
      id: newID(),
      name: "",
      user_id: data?.users[0]?.id || "",
      templates: [],
      scope: "all",
      servers: [],
      nodes: [],
      endpoints: [],
      groups: [
        { type: "selector", tag: "proxy" },
        { type: "direct", tag: "direct" },
      ],
      token: "",
    });
  }
  async function downloadProfile(profile: Subscription) {
    if (lock.current) return;
    lock.current = true;
    const controller = new AbortController();
    request.current = controller;
    setGenerating(true);
    try {
      const result = await generateSubscription(profile, controller.signal);
      if (result.content && !result.error) {
        download(profile, result);
        if (result.issues.length) setPreview({ profile, result });
      } else setPreview({ profile, result });
    } catch (error) {
      if (!isAbort(error))
        setPreview({ profile, failure: errorText(error, t) });
    } finally {
      lock.current = false;
      if (!controller.signal.aborted) setGenerating(false);
    }
  }
  async function copyLink(profile: Subscription) {
    try {
      await copyText(subscriptionURL(profile));
      notify(t("订阅链接已复制", "Subscription URL copied"), "success");
    } catch (error) {
      notify(errorText(error, t));
    }
  }
  return (
    <LibraryPage
      {...props}
      busy={busy}
      title={t("订阅", "Subscriptions")}
      create={create}
      reload={() => {
        props.reload();
        setRefresh((value) => value + 1);
      }}
    >
      {sourceError && <Notice message={sourceError} />}
      {!profiles.length && (
        <div className="empty-state">
          {t("尚未创建订阅配置", "No subscription configurations created")}
        </div>
      )}
      <div className="fleet-grid">
        {profiles.map((profile) => (
          <section className="card" key={profile.id}>
            <div className="library-card-heading">
              <strong>{profile.name}</strong>
              <div className="library-actions">
                <IconButton
                  icon="tune"
                  label={t("编辑", "Edit")}
                  disabled={busy || sourceLoading}
                  onClick={() => edit(structuredClone(profile))}
                />
                <IconButton
                  icon="content_copy"
                  label={t("复制配置", "Duplicate configuration")}
                  disabled={busy || sourceLoading}
                  onClick={() =>
                    edit({
                      ...structuredClone(profile),
                      id: newID(),
                      token: "",
                      name: `${profile.name} (${t("副本", "Copy")})`,
                    })
                  }
                />
                <IconButton
                  icon="delete"
                  label={t("删除", "Delete")}
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      t("删除订阅配置", "Delete subscription configuration"),
                      `${profile.name} · ${t("删除后订阅链接立即失效。", "Its subscription URL stops working immediately.")}`,
                      () => {
                        void save(
                          {
                            ...data!,
                            subscriptions: profiles.filter(
                              (item) => item.id !== profile.id,
                            ),
                          },
                          t(
                            "订阅配置已删除",
                            "Subscription configuration deleted",
                          ),
                        );
                      },
                    )
                  }
                />
              </div>
            </div>
            <div className="data-line">
              <span className="label">{t("用户模板", "User template")}</span>
              <span className="value">
                {data?.users.find((user) => user.id === profile.user_id)
                  ?.name || t("未选择或已删除", "Not selected or deleted")}
              </span>
            </div>
            <div className="data-line">
              <span className="label">{t("节点", "Nodes")}</span>
              <span className="value">
                {selectedSubscriptionNodes(profile, sources).length +
                  ((profile.direct?.enabled ??
                  profile.groups.some((group) => group.type === "direct"))
                    ? 1
                    : 0)}
              </span>
            </div>
            <div className="library-actions subscription-card-actions">
              <button
                className="button small"
                disabled={busy}
                onClick={() => setPreview({ profile })}
              >
                <Icon name="visibility" />
                {t("预览", "Preview")}
              </button>
              <button
                className="button small"
                disabled={busy}
                onClick={() => void downloadProfile(profile)}
              >
                <Icon name="download" />
                {t("下载", "Download")}
              </button>
              <button
                className="button small"
                disabled={busy}
                onClick={() => void copyLink(profile)}
              >
                <Icon name="share" />
                {t("复制链接", "Copy URL")}
              </button>
              <IconButton
                icon="sync"
                label={t("重置订阅链接", "Reset subscription URL")}
                disabled={busy}
                onClick={() =>
                  confirm(
                    t("重置订阅链接", "Reset subscription URL"),
                    t(
                      "旧链接立即失效，需要重新导入客户端。",
                      "The old URL stops working immediately. Import the new URL into your client.",
                    ),
                    () => {
                      void save(
                        {
                          ...data!,
                          subscriptions: profiles.map((item) =>
                            item.id === profile.id
                              ? { ...item, reset_token: true }
                              : item,
                          ),
                        },
                        t("订阅链接已重置", "Subscription URL reset"),
                      );
                    },
                  )
                }
              />
            </div>
          </section>
        ))}
      </div>
      {generating && (
        <div className="subscription-progress" role="status">
          <Spinner />
          {t("正在生成配置", "Generating configuration")}
        </div>
      )}
      {editing && data && (
        <SubscriptionDialog
          key={editing.id}
          initial={editing}
          data={data}
          sources={sources}
          busy={props.busy}
          confirm={confirm}
          preview={(profile) => setPreview({ profile })}
          close={() => setEditing(undefined)}
          save={async (profile) => {
            const ok = await save(
              {
                ...data,
                subscriptions: profiles.some((item) => item.id === profile.id)
                  ? profiles.map((item) =>
                      item.id === profile.id ? profile : item,
                    )
                  : [...profiles, profile],
              },
              t("订阅配置已保存", "Subscription configuration saved"),
            );
            if (ok) setEditing(undefined);
            return ok;
          }}
        />
      )}
      {preview && (
        <SubscriptionPreview preview={preview} close={() => setPreview(null)} />
      )}
    </LibraryPage>
  );
}

function SubscriptionDialog({
  initial,
  data,
  sources,
  busy,
  close,
  save,
  confirm,
  preview,
}: {
  initial: Subscription;
  data: LibraryData;
  sources: SubscriptionSource[];
  busy: boolean;
  close: () => void;
  save: (profile: Subscription) => Promise<boolean>;
  confirm: LibraryViewProps["confirm"];
  preview: (profile: Subscription) => void;
}) {
  const { t } = useUI();
  const [profile, setProfile] = useState(() =>
    editableSubscription(initial, sources),
  );
  const baseline = useRef(profile);
  const [selectingTemplates, setSelectingTemplates] = useState(false);
  const disabled = busy;
  const dirty = JSON.stringify(baseline.current) !== JSON.stringify(profile);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  function update(value: Partial<Subscription>) {
    setProfile((current) => ({ ...current, ...value }));
  }
  function onClose() {
    if (disabled) return;
    if (dirty)
      confirm(
        t("放弃修改", "Discard changes"),
        t("尚未保存的修改将丢失。", "Unsaved changes will be lost."),
        close,
      );
    else close();
  }
  function valid() {
    try {
      if (
        !profile.name.trim() ||
        new TextEncoder().encode(profile.name.trim()).length > 128
      )
        throw new Error(
          t(
            "配置名称需为 1–128 字节",
            "The configuration name must contain 1–128 bytes",
          ),
        );
      if (!profile.templates?.length && !profile.content?.trim())
        throw new Error(t("请选择客户端模板", "Select client templates"));
      if (
        profile.groups.some((group) => !group.tag.trim()) ||
        new Set(profile.groups.map((group) => group.tag.trim())).size !==
          profile.groups.length
      )
        throw new Error(
          t(
            "出站组 tag 不能为空或重复",
            "Outbound group tags must be nonempty and unique",
          ),
        );
      return true;
    } catch (error) {
      notify(errorText(error, t));
      return false;
    }
  }
  function normalized() {
    return {
      ...profile,
      name: profile.name.trim(),
      direct: profile.direct && {
        ...profile.direct,
        tag: profile.direct.tag.trim(),
      },
      endpoints: profile.endpoints.map((endpoint) => ({
        ...endpoint,
        name: endpoint.name?.trim(),
      })),
      groups: profile.groups.map((group) => ({
        ...group,
        tag: group.tag.trim(),
      })),
    };
  }
  const userOptions = [
    { value: "", label: t("请选择用户模板", "Select a user template") },
    ...data.users.map((user) => ({ value: user.id, label: user.name })),
  ];
  if (
    profile.user_id &&
    !data.users.some((user) => user.id === profile.user_id)
  )
    userOptions.push({
      value: profile.user_id,
      label: t("用户模板已删除", "Deleted user template"),
    });
  return (
    <>
      <Dialog
        title={
          initial.token
            ? t("编辑订阅配置", "Edit subscription configuration")
            : t("创建订阅配置", "Create subscription configuration")
        }
        className="library-editor-dialog subscription-dialog"
        busy={disabled}
        onClose={onClose}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && valid()) void save(normalized());
          }}
        >
          <div className="subscription-dialog-body">
            <fieldset className="subscription-fields" disabled={disabled}>
              <div className="subscription-form-grid">
                <label className="field">
                  <span className="field-label">
                    {t("配置名称", "Configuration name")}
                  </span>
                  <input
                    className="input"
                    value={profile.name}
                    required
                    maxLength={128}
                    autoFocus
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </label>
                <div className="field">
                  <label className="field-label" htmlFor="subscription-user">
                    {t("用户模板", "User template")}
                  </label>
                  <Select
                    id="subscription-user"
                    options={userOptions}
                    value={profile.user_id}
                    disabled={disabled}
                    onChange={(user_id) => update({ user_id })}
                  />
                </div>
              </div>
              <div className="field subscription-template-field">
                <div className="library-card-heading">
                  <span className="field-label">{t("模板", "Templates")}</span>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => setSelectingTemplates(true)}
                  >
                    <Icon name="content_copy" />
                    {t("选择模板", "Select templates")}
                  </button>
                </div>
                {!!profile.templates?.length && (
                  <ol className="subscription-template-list">
                    {profile.templates.map((template) => (
                      <li key={template.id}>
                        <span>{template.name}</span>
                        <span className="badge">
                          {template.kind === "config"
                            ? t("完整配置", "Full configuration")
                            : template.kind}
                        </span>
                        <IconButton
                          icon="close"
                          label={t("移除模板", "Remove template")}
                          onClick={() =>
                            update({
                              templates: profile.templates!.filter(
                                (item) => item.id !== template.id,
                              ),
                            })
                          }
                        />
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <SubscriptionNodes
                profile={profile}
                sources={sources}
                busy={busy}
                update={update}
              />
            </fieldset>
          </div>
          <div className="row-actions dialog-actions">
            <button
              type="button"
              className="button dialog-leading"
              disabled={disabled}
              onClick={() => preview(normalized())}
            >
              <Icon name="visibility" />
              {t("预览", "Preview")}
            </button>
            <button
              type="button"
              className="button"
              disabled={disabled}
              onClick={onClose}
            >
              {t("取消", "Cancel")}
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={disabled}
            >
              {busy ? <Spinner /> : <Icon name="check" />}
              {t("保存", "Save")}
            </button>
          </div>
        </form>
      </Dialog>
      {selectingTemplates && (
        <ClientTemplatePicker
          templates={data.templates.filter(
            (template) => template.target === "client",
          )}
          selected={profile.templates || []}
          close={() => setSelectingTemplates(false)}
          apply={(templates) => {
            update({
              templates: structuredClone(templates),
              content: undefined,
            });
            setSelectingTemplates(false);
          }}
        />
      )}
    </>
  );
}

function ClientTemplatePicker({
  templates,
  selected,
  close,
  apply,
}: {
  templates: ConfigTemplate[];
  selected: ConfigTemplate[];
  close: () => void;
  apply: (templates: ConfigTemplate[]) => void;
}) {
  const { t } = useUI();
  const [chosen, setChosen] = useState(selected);
  const currentIDs = new Set(templates.map((template) => template.id));
  const options = [
    ...templates,
    ...selected.filter((template) => !currentIDs.has(template.id)),
  ];
  return (
    <Dialog
      title={t("选择客户端模板", "Select client templates")}
      className="library-editor-dialog subscription-template-picker"
      onClose={close}
    >
      <div className="subscription-dialog-body">
        {!options.length && (
          <p className="hint">{t("暂无客户端模板", "No client templates")}</p>
        )}
        {options.map((template) => {
          const checked = chosen.some((item) => item.id === template.id);
          return (
            <label className="library-user-option" key={template.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={template.kind === "outbounds" && !checked}
                onChange={(event) =>
                  setChosen((previous) =>
                    event.target.checked
                      ? [...previous, template]
                      : previous.filter((item) => item.id !== template.id),
                  )
                }
              />
              <span>{template.name}</span>
              <span className="badge">
                {template.kind === "config"
                  ? t("完整配置", "Full configuration")
                  : template.kind}
              </span>
              {!currentIDs.has(template.id) && (
                <span className="hint">{t("已保存副本", "Saved copy")}</span>
              )}
              {template.kind === "outbounds" && (
                <span className="hint">
                  {t("由订阅生成", "Generated by subscription")}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <div className="row-actions dialog-actions">
        <button type="button" className="button" onClick={close}>
          {t("取消", "Cancel")}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!chosen.length}
          onClick={() => apply(chosen)}
        >
          {t("使用模板", "Use templates")} ({chosen.length})
        </button>
      </div>
    </Dialog>
  );
}

function SubscriptionPreview({
  preview,
  close,
}: {
  preview: PreviewState;
  close: () => void;
}) {
  const { t } = useUI();
  const [result, setResult] = useState(preview.result || null);
  const [failure, setFailure] = useState(preview.failure || "");
  const [loading, setLoading] = useState(!preview.result && !preview.failure);
  useEffect(() => {
    setResult(preview.result || null);
    setFailure(preview.failure || "");
    if (preview.result || preview.failure) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    generateSubscription(preview.profile, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch((error) => {
        if (!isAbort(error)) setFailure(errorText(error, t));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [preview]);
  async function copy() {
    if (!result?.content) return;
    try {
      await copyText(result.content);
      notify(t("配置已复制", "Configuration copied"), "success");
    } catch (error) {
      notify(errorText(error, t));
    }
  }
  return (
    <Dialog
      title={
        preview.profile.name
          ? `${preview.profile.name} · ${t("预览", "Preview")}`
          : t("预览配置", "Preview configuration")
      }
      className="library-editor-dialog subscription-preview-dialog"
      onClose={close}
    >
      <div className="subscription-dialog-body">
        {loading && (
          <div className="subscription-progress" role="status">
            <Spinner />
            {t("正在生成并检查配置", "Generating and checking configuration")}
          </div>
        )}
        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
        {result && <GenerationResult result={result} />}
      </div>
      <div className="row-actions dialog-actions">
        <button type="button" className="button" onClick={close}>
          {t("关闭", "Close")}
        </button>
        <button
          type="button"
          className="button"
          disabled={!result?.content || loading}
          onClick={() => void copy()}
        >
          <Icon name="content_copy" />
          {t("复制", "Copy")}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!result?.content || loading}
          onClick={() => result && download(preview.profile, result)}
        >
          <Icon name="download" />
          {t("下载", "Download")}
        </button>
      </div>
    </Dialog>
  );
}

function GenerationResult({ result }: { result: SubscriptionResult }) {
  const { t } = useUI();
  return (
    <section className="subscription-section">
      <div className="library-card-heading">
        <strong>
          {t("生成结果", "Generated configuration")} · {result.count}{" "}
          {t("个节点", "nodes")}
        </strong>
      </div>
      {result.error && (
        <p className="field-error" role="alert">
          {subscriptionMessage(result.error, t)}
          {result.reference && ` · ${result.reference}`}
        </p>
      )}
      {!!result.validation_errors?.length && (
        <div role="alert">
          <p className="field-error">
            {t("配置检查发现错误", "Configuration check found errors")}
          </p>
          <ul className="subscription-validation-errors">
            {result.validation_errors.map((error, index) => (
              <li key={index}>
                <code>{error.path}</code> · {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.issues.length > 0 && (
        <details
          className="subscription-issues"
          open={!result.content || undefined}
        >
          <summary>
            {result.issues.length} {t("项生成说明", "generation details")}
          </summary>
          <ul>
            {result.issues.map((issue, index) => (
              <li key={index}>
                {[issue.server, issue.node, subscriptionMessage(issue.code, t)]
                  .filter(Boolean)
                  .join(" · ")}
              </li>
            ))}
          </ul>
        </details>
      )}
      {result.content && !result.error && (
        <pre className="subscription-preview">{result.content}</pre>
      )}
    </section>
  );
}
