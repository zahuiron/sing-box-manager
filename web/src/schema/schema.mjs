// From S-Panel (GPL-3.0-or-later); modified 2026-11-05. See web/THIRD_PARTY.md.
// JSON Schema Draft 2020-12 adapter for core and bundled template schemas.
export function resolve(schema, root, seen = new Set()) {
  if (!schema || typeof schema !== "object") return {};
  if (!schema.$ref) return schema;
  if (!schema.$ref.startsWith("#/")) return { ...schema, $unresolved: true };
  if (seen.has(schema.$ref)) return {};
  const next = new Set(seen).add(schema.$ref);
  const target = schema.$ref
    .slice(2)
    .split("/")
    .reduce((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  if (!target) return { ...schema, $unresolved: true };
  const { $ref, ...rest } = schema;
  return { ...resolve(target, root, next), ...rest };
}

export function branches(schema, root) {
  const node = resolve(schema, root);
  if (Array.isArray(node.type))
    return node.type.flatMap((type) => branches({ ...node, type }, root));
  const choices = node.oneOf || node.anyOf;
  return choices ? choices.flatMap((s) => branches(s, root)) : [node];
}

function discriminator(node, root) {
  const type = resolve(node.properties?.type, root);
  return type.const ?? (type.enum?.length === 1 ? type.enum[0] : null);
}

export function protocolSchemas(root, category = "inbounds") {
  const document = resolve(root, root);
  const property = resolve(document.properties?.[category], root);
  const result = new Map();
  for (const branch of branches(property.items || {}, root)) {
    const node = effectiveSchema(branch, root, {});
    const value = discriminator(node, root);
    if (value !== null) result.set(value, node);
  }
  return result;
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  switch (type) {
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return !type || typeof value === type;
  }
}

export function chooseBranch(schema, root, value) {
  const list = branches(schema, root);
  if (list.length === 1) return list[0];
  const typed = list.filter((s) =>
    matchesType(value, s.type || (s.properties ? "object" : undefined)),
  );
  const candidates = typed.length ? typed : list;
  return (
    candidates.find((s) => discriminator(s, root) === value?.type) ||
    candidates.find((s) => {
      const required = s.required || [];
      return required.every((k) => Object.hasOwn(value || {}, k));
    }) ||
    candidates[0]
  );
}

export function effectiveSchema(schema, root, value) {
  let node = resolve(schema, root);
  if (node.allOf) {
    node = node.allOf.reduce(
      (acc, s) => {
        const item = effectiveSchema(s, root, value);
        return {
          ...acc,
          ...item,
          properties: { ...acc.properties, ...item.properties },
          required: [
            ...new Set([...(acc.required || []), ...(item.required || [])]),
          ],
        };
      },
      { ...node, allOf: undefined },
    );
  }
  if (node.oneOf || node.anyOf) {
    const { oneOf, anyOf, ...rest } = node;
    return { ...rest, ...chooseBranch(node, root, value) };
  }
  return node;
}

export function enumValues(schema, root) {
  const list = branches(schema, root);
  if (list.every((s) => s.enum || Object.hasOwn(s, "const"))) {
    return [...new Set(list.flatMap((s) => s.enum || [s.const]))];
  }
  const node = resolve(schema, root);
  if (node.type === "boolean") return [true, false];
  if (node.type === "null") return [null];
  return null;
}

export function initialValue(schema, root) {
  // Do not use schema defaults: adding a field is an explicit edit.
  const node = resolve(schema, root);
  if (Object.hasOwn(node, "const")) return node.const;
  if (node.oneOf || node.anyOf)
    return initialValue(branches(node, root)[0], root);
  if (node.type === "object" || node.properties) return {};
  if (node.type === "array") return [];
  if (node.type === "null") return null;
  return undefined;
}

export function withoutUnset(value) {
  if (Array.isArray(value))
    return value.filter((item) => item !== undefined).map(withoutUnset);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUnset(item)]),
    );
  return value;
}

export function pointer(parts) {
  return (
    "/" +
    parts
      .map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

export function validateSchema(value, schema, root, path = []) {
  const issues = [];
  const add = (message, suffix = [], code = "schema") =>
    issues.push({
      path: pointer([...path, ...suffix]),
      message,
      severity: "error",
      code,
    });
  const raw = resolve(schema, root);
  if (schema === false) {
    add("此处不允许添加字段");
    return issues;
  }
  if (raw.$unresolved) {
    add("无法解析此字段的 Schema 引用");
    return issues;
  }
  if (raw.allOf)
    for (const item of raw.allOf)
      issues.push(...validateSchema(value, item, root, path));
  const options = raw.oneOf || raw.anyOf;
  if (options) {
    const results = options.map((option) =>
      validateSchema(value, option, root, path),
    );
    const successes = results.filter((errors) => errors.length === 0);
    if (successes.length === 0) {
      const chosen = chooseBranch(raw, root, value);
      issues.push(...validateSchema(value, chosen, root, path));
    } else if (raw.oneOf && successes.length !== 1)
      add("值同时匹配多个互斥的配置分支");
  }
  if (raw.type && !matchesType(value, raw.type)) {
    add(
      `需要 ${Array.isArray(raw.type) ? raw.type.join(" / ") : raw.type} 类型`,
    );
    return issues;
  }
  if (value === undefined) {
    add("请选择或填写字段值");
    return issues;
  }
  if (Object.hasOwn(raw, "const") && value !== raw.const)
    add(`固定值应为 ${JSON.stringify(raw.const)}`);
  if (
    raw.enum &&
    !raw.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  )
    add("请选择当前目标核心支持的值");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) add("需要有效数字");
    if (raw.minimum !== undefined && value < raw.minimum)
      add(`不能小于 ${raw.minimum}`);
    if (raw.maximum !== undefined && value > raw.maximum)
      add(`不能大于 ${raw.maximum}`);
    if (raw.exclusiveMinimum !== undefined && value <= raw.exclusiveMinimum)
      add(`必须大于 ${raw.exclusiveMinimum}`);
    if (raw.exclusiveMaximum !== undefined && value >= raw.exclusiveMaximum)
      add(`必须小于 ${raw.exclusiveMaximum}`);
    if (
      raw.multipleOf &&
      Math.abs(value / raw.multipleOf - Math.round(value / raw.multipleOf)) >
        1e-8
    )
      add(`必须为 ${raw.multipleOf} 的倍数`);
  }
  if (typeof value === "string") {
    if (raw.minLength !== undefined && [...value].length < raw.minLength)
      add(`至少需要 ${raw.minLength} 个字符`);
    if (raw.maxLength !== undefined && [...value].length > raw.maxLength)
      add(`最多允许 ${raw.maxLength} 个字符`);
    if (raw.pattern) {
      try {
        if (!new RegExp(raw.pattern, "u").test(value))
          add("格式不符合官方定义");
      } catch {
        add("字段校验规则无法解析");
      }
    }
    if (raw.format === "ipv4" && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value))
      add("需要 IPv4 地址");
    if (
      raw.format === "uuid" &&
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
    )
      add("需要有效 UUID");
  }
  if (Array.isArray(value)) {
    if (raw.minItems !== undefined && value.length < raw.minItems)
      add(`至少添加 ${raw.minItems} 项`);
    if (raw.maxItems !== undefined && value.length > raw.maxItems)
      add(`最多添加 ${raw.maxItems} 项`);
    if (
      raw.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      add("不能有重复项");
    value.forEach((item, i) => {
      const child = raw.prefixItems?.[i] ?? raw.items;
      if (child !== undefined)
        issues.push(...validateSchema(item, child, root, [...path, i]));
    });
  } else if (value !== null && typeof value === "object") {
    for (const key of raw.required || [])
      if (!Object.hasOwn(value, key))
        add(`缺少必填字段 ${key}`, [key], "required");
    for (const [key, item] of Object.entries(value)) {
      let child = raw.properties?.[key];
      if (child === undefined && raw.patternProperties) {
        for (const [pattern, itemSchema] of Object.entries(
          raw.patternProperties,
        ))
          if (new RegExp(pattern).test(key)) child = itemSchema;
      }
      if (child === undefined && raw.additionalProperties === false)
        add("当前协议不支持此字段", [key], "unsupported");
      else if (
        child !== undefined ||
        typeof raw.additionalProperties === "object"
      )
        issues.push(
          ...validateSchema(item, child ?? raw.additionalProperties, root, [
            ...path,
            key,
          ]),
        );
    }
    for (const [key, required] of Object.entries(raw.dependentRequired || {}))
      if (Object.hasOwn(value, key)) {
        for (const dependency of required)
          if (!Object.hasOwn(value, dependency)) {
            const related = pointer([...path, dependency]);
            issues.push({
              path: pointer([...path, key]),
              related: [related],
              severity: "error",
              code: "dependency",
              message: `需要同时设置 ${dependency}`,
            });
            issues.push({
              path: related,
              related: [pointer([...path, key])],
              severity: "error",
              code: "required",
              message: `字段 ${key} 需要此字段`,
            });
          }
      }
  }
  if (raw.not && validateSchema(value, raw.not, root, path).length === 0)
    add("此组合不被允许");
  if (raw.if) {
    const condition = validateSchema(value, raw.if, root, path).length === 0;
    if (condition && raw.then)
      issues.push(...validateSchema(value, raw.then, root, path));
    if (!condition && raw.else)
      issues.push(...validateSchema(value, raw.else, root, path));
  }
  return issues;
}
