import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog, Icon, IconButton, SecretInput, useUI } from "./ui";
import {
  branches,
  chooseBranch,
  effectiveSchema,
  enumValues,
  initialValue,
  pointer,
  resolve,
  withoutUnset,
  type Issue,
  type Schema,
} from "./schema/schema.mjs";

type Path = (string | number)[];
export type FieldActions = (
  path: Path,
  value: any,
  change: (value: any) => void,
) => ReactNode;
const descriptions: Record<string, string> = {
  type: "类型",
  tag: "标签",
  listen: "监听地址",
  listen_port: "监听端口",
  server: "服务器地址",
  server_port: "服务器端口",
  users: "用户",
  password: "密码 / 密钥",
  username: "用户名",
  uuid: "UUID",
  tls: "TLS",
  enabled: "启用",
  domain: "域名",
  server_name: "服务器名称",
  certificate_provider: "证书提供者",
  certificate_path: "证书路径",
  key_path: "私钥路径",
  network: "网络",
  method: "加密方法",
  transport: "传输配置",
  flow: "Flow",
  reality: "REALITY",
  private_key: "私钥",
  public_key: "公钥",
  short_id: "Short ID",
  handshake: "握手服务器",
  multiplex: "多路复用",
  detour: "转交目标",
  alpn: "ALPN",
  up_mbps: "上传带宽 / Mbps",
  down_mbps: "下载带宽 / Mbps",
  obfs: "混淆",
  dns: "DNS",
  route: "路由",
};

function infer(value: any): Schema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return { type: "array", items: value.length ? infer(value[0]) : {} };
  if (value && typeof value === "object")
    return { type: "object", additionalProperties: true };
  return {
    type:
      typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : "string",
  };
}

function initial(schema: Schema, root: Schema): any {
  const value = initialValue(schema, root);
  if (value !== undefined) return value;
  const type = resolve(schema, root).type;
  return type === "boolean" ? false : undefined;
}

function NumberValue({
  value,
  change,
  integer,
  label,
}: {
  value: any;
  change: (value: any) => void;
  integer: boolean;
  label: string;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const last = useRef(value);
  useEffect(() => {
    if (!Object.is(value, last.current)) {
      setText(value === undefined ? "" : String(value));
      last.current = value;
    }
  }, [value]);
  return (
    <input
      className="input mono-input"
      aria-label={label}
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const number = next.trim() === "" ? undefined : Number(next);
        last.current =
          number !== undefined &&
          Number.isFinite(number) &&
          (!integer || Number.isInteger(number))
            ? number
            : undefined;
        change(last.current);
      }}
    />
  );
}

export default function FieldEditor({
  value,
  schema,
  root,
  onChange,
  issues = [],
  basePath = [],
  disabled = false,
  renderActions,
}: {
  value: any;
  schema: Schema;
  root: Schema;
  onChange: (value: any) => void;
  issues?: Issue[];
  basePath?: Path;
  disabled?: boolean;
  renderActions?: FieldActions;
}) {
  const [data, setData] = useState<any>(() => structuredClone(value));
  const last = useRef(JSON.stringify(value));
  const current = useRef(data);
  current.current = data;
  useEffect(() => {
    const text = JSON.stringify(value);
    if (text !== last.current) {
      last.current = text;
      setData(structuredClone(value));
    }
  }, [value]);
  function commit(path: Path, value: any, remove = false) {
    const next = path.length ? structuredClone(current.current) : value;
    if (path.length) {
      let parent = next;
      for (let index = 0; index < path.length - 1; index++) {
        const key = path[index];
        if (!parent[key] || typeof parent[key] !== "object")
          parent[key] = typeof path[index + 1] === "number" ? [] : {};
        parent = parent[key];
      }
      const key = path.at(-1)!;
      if (remove) {
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
      } else parent[key] = value;
    }
    current.current = next;
    setData(next);
    const clean = withoutUnset(next);
    last.current = JSON.stringify(clean);
    onChange(clean);
  }
  return (
    <fieldset className="schema-form" disabled={disabled}>
      <ValueControl
        value={data}
        schema={schema}
        root={root}
        path={[]}
        basePath={basePath}
        issues={issues}
        commit={commit}
        renderActions={renderActions}
      />
    </fieldset>
  );
}

function FieldHeading({
  label,
  summary,
  actions,
}: {
  label: ReactNode;
  summary?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <span className="schema-field-heading">
      <span className="schema-field-label">
        {label}
        {summary && <span className="schema-summary-type">{summary}</span>}
      </span>
      <span
        className="schema-field-actions"
        onClick={summary ? (event) => event.preventDefault() : undefined}
      >
        {actions}
      </span>
    </span>
  );
}

interface ControlProps {
  value: any;
  schema: Schema;
  root: Schema;
  path: Path;
  basePath: Path;
  issues: Issue[];
  commit: (path: Path, value: any, remove?: boolean) => void;
  renderActions?: FieldActions;
  renderHeading?: (summary?: ReactNode) => ReactNode;
}

function ValueControl(props: ControlProps) {
  const { value, schema, root, path, commit } = props;
  const { t } = useUI();
  const raw = resolve(schema, root);
  const options = enumValues(schema, root);
  const id = useId();
  const render = (control: ReactNode) => (
    <>
      {props.renderHeading?.()}
      {control}
    </>
  );
  if (options) {
    const index = options.findIndex(
      (option) => JSON.stringify(option) === JSON.stringify(value),
    );
    return render(
      <select
        className="select"
        aria-label={String(path.at(-1) || "type")}
        value={
          index < 0 ? (value === undefined ? "" : "unknown") : String(index)
        }
        onChange={(event) => commit(path, options[Number(event.target.value)])}
      >
        <option value="" disabled>
          {t("请选择", "Select a value")}
        </option>
        {index < 0 && value !== undefined && (
          <option value="unknown">
            {String(value)} · {t("未列入 Schema", "Not in schema")}
          </option>
        )}
        {options.map((option, index) => (
          <option key={index} value={String(index)}>
            {typeof option === "boolean"
              ? option
                ? t("true · 开启", "true · On")
                : t("false · 关闭", "false · Off")
              : option === ""
                ? '""'
                : String(option)}
          </option>
        ))}
      </select>,
    );
  }
  if (path.length > 24)
    return render(
      <pre className="schema-preview">{JSON.stringify(value, null, 2)}</pre>,
    );
  const choices = branches(raw, root);
  if (
    choices.length > 1 &&
    choices.every((choice) => resolve(choice, root).properties?.type)
  )
    return <ObjectValue {...props} />;
  if (choices.length > 1) {
    const chosen = chooseBranch(raw, root, value);
    const index = Math.max(
      0,
      choices.findIndex(
        (choice) => JSON.stringify(choice) === JSON.stringify(chosen),
      ),
    );
    const selector = (
      <select
        className="select inline"
        aria-label={t("值类型", "Value type")}
        value={index}
        onChange={(event) =>
          commit(path, initial(choices[Number(event.target.value)], root))
        }
      >
        {choices.map((choice, index) => (
          <option key={index} value={index}>
            {choice.title ||
              (choice.enum || Object.hasOwn(choice, "const")
                ? t("选项", "Choice")
                : choice.type ||
                  (choice.properties ? "object" : t("值", "Value")))}
          </option>
        ))}
      </select>
    );
    const heading = props.renderHeading;
    return heading ? (
      <ValueControl
        {...props}
        schema={chosen}
        renderHeading={(summary) =>
          heading(
            <>
              {selector}
              {summary}
            </>,
          )
        }
      />
    ) : (
      <div className="union-control">
        {selector}
        <ValueControl {...props} schema={chosen} />
      </div>
    );
  }
  const effective = effectiveSchema(raw, root, value);
  const type = effective.type || (effective.properties ? "object" : undefined);
  if (!type && !effective.properties) {
    const fallback = Object.keys(effective).some((key) =>
      ["enum", "const"].includes(key),
    )
      ? infer(value)
      : {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "object", additionalProperties: true },
            { type: "array", items: {} },
            { type: "null" },
          ],
        };
    return <ValueControl {...props} schema={fallback} />;
  }
  if (type === "object") return <ObjectValue {...props} />;
  if (type === "array") return <ArrayValue {...props} schema={effective} />;
  if (type === "null") return render(<span className="badge">null</span>);
  if (type === "number" || type === "integer")
    return render(
      <NumberValue
        value={value}
        integer={type === "integer"}
        label={String(path.at(-1))}
        change={(next) => commit(path, next)}
      />,
    );
  const name = String(path.at(-1));
  const secret =
    /password|secret|token|private_key|account_key|(^|_)psk$|^auth(_str)?$|^userkey$/.test(
      name,
    ) ||
    (path.includes("tls") && name === "key") ||
    (typeof value === "string" &&
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value));
  const multiline =
    (typeof value === "string" && value.includes("\n")) ||
    name === "account_key" ||
    (path.includes("tls") && ["certificate", "key"].includes(name));
  if (secret)
    return render(
      <SecretInput
        id={id}
        value={value === undefined ? "" : String(value)}
        onChange={(next) => commit(path, next)}
        multiline={multiline}
      />,
    );
  if (multiline)
    return render(
      <textarea
        className="input ca-input"
        rows={5}
        aria-label={name}
        value={value === undefined ? "" : String(value)}
        onChange={(event) => commit(path, event.target.value)}
        spellCheck={false}
      />,
    );
  return render(
    <input
      className="input mono-input"
      aria-label={String(path.at(-1) || "value")}
      value={
        value === undefined
          ? ""
          : typeof value === "string"
            ? value
            : JSON.stringify(value)
      }
      onChange={(event) => commit(path, event.target.value)}
      spellCheck={false}
    />,
  );
}

function ObjectValue(props: ControlProps) {
  const { value, schema, root, path, basePath, issues, commit } = props;
  const { t, language } = useUI();
  const object =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const effective = effectiveSchema(schema, root, object);
  const options = branches(schema, root).filter(
    (choice) => resolve(choice, root).properties?.type,
  );
  const discriminated = options.length > 1;
  const [picker, setPicker] = useState(false);
  const [open, setOpen] = useState(path.length < 2);
  const properties: Record<string, Schema> = { ...effective.properties };
  const required = new Set<string>(effective.required || []);
  if (discriminated)
    properties.type = {
      type: "string",
      enum: [
        ...new Set(
          options
            .flatMap((option) => {
              const field = resolve(
                resolve(option, root).properties.type,
                root,
              );
              return field.enum || [field.const];
            })
            .filter((value) => value !== undefined),
        ),
      ],
    };
  const keys = Object.keys(object);
  if (
    (discriminated || required.has("type")) &&
    properties.type &&
    !keys.includes("type")
  )
    keys.unshift("type");
  const content = (
    <div className={path.length ? "schema-object nested" : "schema-object"}>
      {keys.map((key) => {
        const fieldPath = [...path, key],
          absolute = pointer([...basePath, ...fieldPath]);
        const field =
          properties[key] ||
          (typeof effective.additionalProperties === "object"
            ? effective.additionalProperties
            : infer(object[key]));
        const errors = issues.filter((issue) => issue.path === absolute);
        const description = field.title || descriptions[key];
        const unsupported =
          !properties[key] && effective.additionalProperties === false;
        return (
          <div
            className={`schema-field ${errors.some((issue) => issue.severity === "error") || unsupported ? "invalid" : ""}`}
            key={key}
          >
            <ValueControl
              {...props}
              value={object[key]}
              schema={field}
              path={fieldPath}
              renderHeading={(summary) => (
                <FieldHeading
                  summary={summary}
                  label={
                    <>
                      <span className="field-label schema-key">{key}</span>
                      {required.has(key) && (
                        <span className="field-required">
                          {t("必填", "Required")}
                        </span>
                      )}
                      {language === "zh-CN" && description && (
                        <span className="schema-description">
                          {description}
                        </span>
                      )}
                    </>
                  }
                  actions={
                    <>
                      {props.renderActions?.(
                        [...basePath, ...fieldPath],
                        object[key],
                        (next) => commit(fieldPath, next),
                      )}
                      {!(
                        (discriminated || required.has("type")) &&
                        key === "type"
                      ) && (
                        <IconButton
                          icon="close"
                          label={`${t("删除字段", "Remove field")} ${key}`}
                          onClick={() => commit(fieldPath, undefined, true)}
                        />
                      )}
                    </>
                  }
                />
              )}
            />
            {unsupported && (
              <div className="field-error">
                {t(
                  "当前协议的 Schema 未列出此字段，已保留原值",
                  "This field is not in the current schema. Its value is preserved",
                )}
              </div>
            )}
            {errors.map((issue, index) => (
              <div
                className={`field-error ${issue.severity === "warning" ? "warning" : ""}`}
                key={index}
              >
                {issue.message}
              </div>
            ))}
          </div>
        );
      })}
      {!keys.length && (
        <div className="hint">{t("尚未添加字段", "No fields added")}</div>
      )}
      <button
        className="button small"
        type="button"
        disabled={(discriminated || required.has("type")) && !object.type}
        onClick={() => setPicker(true)}
      >
        <Icon name="add" />
        {t("添加字段", "Add field")}
      </button>
      {picker && (
        <FieldPicker
          properties={properties}
          present={keys}
          additional={effective.additionalProperties}
          root={root}
          onClose={() => setPicker(false)}
          onSelect={(key, field) => {
            commit([...path, key], initial(field, root));
            setPicker(false);
          }}
        />
      )}
    </div>
  );
  if (!path.length) return content;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="schema-summary">
        {props.renderHeading?.(
          <>
            {t("对象", "Object")} · {Object.keys(object).length}
          </>,
        ) ?? (
          <>
            {t("对象", "Object")} · {Object.keys(object).length}
          </>
        )}
      </summary>
      {open && content}
    </details>
  );
}

function ArrayValue(props: ControlProps) {
  const { value, schema, root, path, commit } = props;
  const { t } = useUI();
  const values: any[] = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(path.length < 2);
  const [visible, setVisible] = useState(30);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="schema-array"
    >
      <summary className="schema-summary">
        {props.renderHeading?.(
          <>
            {t("数组", "Array")} · {values.length}
          </>,
        ) ?? (
          <>
            {t("数组", "Array")} · {values.length}
          </>
        )}
      </summary>
      {open && (
        <div className="schema-object nested">
          {values.slice(0, visible).map((item, index) => (
            <div className="schema-array-item" key={index}>
              <ValueControl
                {...props}
                path={[...path, index]}
                value={item}
                schema={schema.prefixItems?.[index] ?? schema.items ?? {}}
                renderHeading={(summary) => (
                  <FieldHeading
                    summary={summary}
                    label={<span className="text-mono-caption">[{index}]</span>}
                    actions={
                      <>
                        {props.renderActions?.(
                          [...props.basePath, ...path, index],
                          item,
                          (next) => commit([...path, index], next),
                        )}
                        <IconButton
                          icon="close"
                          label={t("删除条目", "Remove item")}
                          onClick={() =>
                            commit([...path, index], undefined, true)
                          }
                        />
                      </>
                    }
                  />
                )}
              />
            </div>
          ))}
          {values.length > visible && (
            <button
              className="button small"
              type="button"
              onClick={() => setVisible((count) => count + 30)}
            >
              {t("显示更多", "Show more")}
            </button>
          )}
          <button
            className="button small"
            type="button"
            disabled={
              typeof schema.maxItems === "number" &&
              values.length >= schema.maxItems
            }
            onClick={() => {
              const next = [
                ...values,
                initial(
                  schema.prefixItems?.[values.length] ?? schema.items ?? {},
                  root,
                ),
              ];
              commit(path, next);
              setVisible((count) => Math.max(count, next.length));
            }}
          >
            <Icon name="add" />
            {t("添加条目", "Add item")}
          </button>
        </div>
      )}
    </details>
  );
}

function FieldPicker({
  properties,
  present,
  additional,
  root,
  onSelect,
  onClose,
}: {
  properties: Record<string, Schema>;
  present: string[];
  additional: any;
  root: Schema;
  onSelect: (key: string, schema: Schema) => void;
  onClose: () => void;
}) {
  const { t } = useUI();
  const [search, setSearch] = useState("");
  const [custom, setCustom] = useState("");
  const [kind, setKind] = useState("string");
  const fields = useMemo(
    () =>
      Object.entries(properties).filter(
        ([key]) =>
          !present.includes(key) &&
          key.toLowerCase().includes(search.toLowerCase()),
      ),
    [properties, present, search],
  );
  return (
    <Dialog title={t("添加字段", "Add field")} onClose={onClose}>
      <input
        className="input field-search"
        type="search"
        autoFocus
        placeholder={t("搜索字段", "Search fields")}
        aria-label={t("搜索字段", "Search fields")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="field-options">
        {fields.map(([key, field]) => (
          <button
            className="field-option"
            type="button"
            key={key}
            onClick={() => onSelect(key, field)}
          >
            <span className="schema-key">{key}</span>
            <span className="hint">
              {resolve(field, root).title ||
                descriptions[key] ||
                resolve(field, root).description ||
                ""}
            </span>
            <Icon name="add" />
          </button>
        ))}
        {!fields.length && (
          <div className="hint">
            {t("没有其他可选字段", "No more matching fields")}
          </div>
        )}
      </div>
      {additional !== false && (
        <div className="custom-field">
          <input
            className="input mono-input"
            aria-label={t("自定义字段名称", "Custom field name")}
            placeholder={t("自定义字段名称", "Custom field name")}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
          />
          <select
            className="select inline"
            value={kind}
            aria-label={t("值类型", "Value type")}
            onChange={(event) => setKind(event.target.value)}
          >
            {[
              "string",
              "integer",
              "number",
              "boolean",
              "object",
              "array",
              "null",
            ].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
          <button
            className="button"
            type="button"
            disabled={
              !custom ||
              present.includes(custom) ||
              ["__proto__", "constructor", "prototype"].includes(custom)
            }
            onClick={() =>
              onSelect(
                custom,
                typeof additional === "object"
                  ? additional
                  : kind === "object"
                    ? { type: kind, additionalProperties: true }
                    : kind === "array"
                      ? { type: kind, items: {} }
                      : { type: kind },
              )
            }
          >
            <Icon name="add" />
          </button>
        </div>
      )}
      <div className="row-actions dialog-actions">
        <button className="button" type="button" onClick={onClose}>
          {t("取消", "Cancel")}
        </button>
      </div>
    </Dialog>
  );
}
