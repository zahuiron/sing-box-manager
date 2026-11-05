declare module "lezer-json5" {
  import type { LRLanguage } from "@codemirror/language";
  export const parser: LRLanguage["parser"];
}
