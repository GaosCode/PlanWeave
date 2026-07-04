export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

export function parseJsonArray(value: string, label: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

export function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`SQLite column '${key}' must be a string.`);
  }
  return value;
}

export function nullableStringColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`SQLite column '${key}' must be a string or null.`);
  }
  return value;
}

export function numberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`SQLite column '${key}' must be numeric.`);
}

export function stringArrayColumn(row: Record<string, unknown>, key: string): string[] {
  const values = parseJsonArray(stringColumn(row, key), key);
  if (!values.every((value): value is string => typeof value === "string")) {
    throw new Error(`SQLite column '${key}' must contain a string array.`);
  }
  return values;
}
