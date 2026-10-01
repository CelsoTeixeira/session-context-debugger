export type Obj = Record<string, unknown>;
export const object = (value: unknown): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 1024 ? value : undefined;
export const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const obj = object(value);
  return string(obj.text) ?? '';
};
export const pointerPart = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');
export const numericFields = (value: unknown): Obj => {
  const out: Obj = {};
  for (const [key, item] of Object.entries(object(value))) {
    if (typeof item === 'number' || item === null) out[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) out[key] = numericFields(item);
  }
  return out;
};
export const stable = (value: unknown): string => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return '{' + Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
};
