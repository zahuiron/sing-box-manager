import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import {
  validateSchema,
  pointer,
  type Issue,
  type Schema,
} from "./schema/schema.mjs";

export type CoreConfig = Record<string, any>;
export const categories = [
  "inbounds",
  "outbounds",
  "endpoints",
  "services",
] as const;
export type Category = (typeof categories)[number];

export function parseConfig(content: string): CoreConfig {
  const errors: ParseError[] = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length)
    throw new Error(
      `JSON · ${printParseErrorCode(errors[0].error)} (${errors[0].offset})`,
    );
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("配置根必须是 JSON 对象 / Configuration must be an object");
  return value;
}

export function configText(value: CoreConfig) {
  return JSON.stringify(value, null, 2) + "\n";
}
export function entries(
  config: CoreConfig,
  category: Category,
): Record<string, any>[] {
  if (config[category] === undefined) return [];
  if (!Array.isArray(config[category]))
    throw new Error(`${category} 必须是数组 / must be an array`);
  return config[category];
}

export function inspectConfig(
  config: CoreConfig,
  schema: Schema | null,
): Issue[] {
  let issues: Issue[] = [];
  if (schema) {
    try {
      issues = validateSchema(config, schema, schema);
    } catch {
      issues.push({
        path: "/",
        message: "部分字段无法完成表单检查，请使用目标核心校验",
        severity: "warning",
      });
    }
  }
  const tags = new Map<string, string>();
  for (const category of categories) {
    if (!Array.isArray(config[category])) continue;
    config[category].forEach((entry: any, index: number) => {
      if (!entry || typeof entry !== "object" || !entry.tag) return;
      const spaces =
        category === "endpoints" ? ["inbounds", "outbounds"] : [category];
      for (const space of spaces) {
        const path = pointer([category, index, "tag"]),
          key = `${space}:${entry.tag}`;
        const previous = tags.get(key);
        if (previous) {
          const message = `tag「${entry.tag}」在同一作用域重复`;
          issues.push(
            { path, message, severity: "error", related: [previous] },
            { path: previous, message, severity: "error", related: [path] },
          );
        } else tags.set(key, path);
      }
    });
  }
  const inbounds = Array.isArray(config.inbounds) ? config.inbounds : [];
  for (let left = 0; left < inbounds.length; left++)
    for (let right = left + 1; right < inbounds.length; right++) {
      const a = inbounds[left],
        b = inbounds[right];
      if (
        !a ||
        !b ||
        !a.type ||
        !a.listen_port ||
        a.listen_port !== b.listen_port ||
        (a.netns || "") !== (b.netns || "")
      )
        continue;
      const networks = (value: any): string[] =>
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.filter((item) => typeof item === "string")
            : [];
      const an = networks(a.network),
        bn = networks(b.network);
      const sameNetwork =
        an.length && bn.length
          ? an.some((value) => bn.includes(value))
          : !an.length && !bn.length && a.type === b.type;
      const aa = typeof a.listen === "string" ? a.listen : "",
        ba = typeof b.listen === "string" ? b.listen : "";
      const overlap =
        aa === ba ||
        aa === "::" ||
        ba === "::" ||
        (aa === "0.0.0.0" && !ba.includes(":")) ||
        (ba === "0.0.0.0" && !aa.includes(":"));
      if (!sameNetwork || !overlap) continue;
      const ap = `/inbounds/${left}/listen_port`,
        bp = `/inbounds/${right}/listen_port`;
      const message = `监听端口 ${a.listen_port} 与同服务器的另一个节点重叠`;
      const severity = a.reuse_addr && b.reuse_addr ? "warning" : "error";
      issues.push(
        { path: ap, message, severity, related: [bp] },
        { path: bp, message, severity, related: [ap] },
      );
    }
  return [
    ...new Map(
      issues.map((issue) => [`${issue.path}:${issue.message}`, issue]),
    ).values(),
  ];
}
