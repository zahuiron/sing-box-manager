export type Schema = Record<string, any>;
export interface Issue {
  path: string;
  message: string;
  severity: string;
  code?: string;
  related?: string[];
}
export function resolve(schema: any, root: Schema): Schema;
export function branches(schema: any, root: Schema): Schema[];
export function effectiveSchema(
  schema: any,
  root: Schema,
  value: unknown,
): Schema;
export function chooseBranch(schema: any, root: Schema, value: unknown): Schema;
export function protocolSchemas(
  root: Schema,
  category?: string,
): Map<string, Schema>;
export function enumValues(schema: any, root: Schema): unknown[] | null;
export function initialValue(schema: any, root: Schema): any;
export function withoutUnset(value: any): any;
export function pointer(parts: (string | number)[]): string;
export function validateSchema(
  value: unknown,
  schema: any,
  root: Schema,
  path?: (string | number)[],
): Issue[];
