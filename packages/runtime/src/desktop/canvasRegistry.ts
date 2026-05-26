import { dirname, join } from "node:path";

export const registryVersion = "desktop-canvases/v1" as const;

export type TaskCanvasRecord = {
  canvasId: string;
  name: string;
  packageDir: string;
  stateFile: string;
  resultsDir: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskCanvasRegistry = {
  version: typeof registryVersion;
  canvases: TaskCanvasRecord[];
  activeCanvasId?: string;
};

type RawTaskCanvasRecord = Partial<TaskCanvasRecord> & {
  id?: unknown;
};

type RawTaskCanvasRegistry = {
  version?: unknown;
  canvases?: unknown;
  activeCanvasId?: unknown;
};

function inferCanvasSiblingPath(packageDir: string, name: string): string {
  const parent = dirname(packageDir);
  return (parent === "." ? name : join(parent, name)).split("\\").join("/");
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeCanvasRecord(record: unknown, index: number): TaskCanvasRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Task canvas registry record ${index} is not an object.`);
  }
  const raw = record as RawTaskCanvasRecord;
  const canvasId = stringField(raw.canvasId) ?? stringField(raw.id);
  const packageDir = stringField(raw.packageDir);
  if (!canvasId) {
    throw new Error(`Task canvas registry record ${index} is missing canvasId.`);
  }
  if (!packageDir) {
    throw new Error(`Task canvas registry record '${canvasId}' is missing packageDir.`);
  }
  return {
    canvasId,
    name: stringField(raw.name) ?? canvasId,
    packageDir,
    stateFile: stringField(raw.stateFile) ?? inferCanvasSiblingPath(packageDir, "state.json"),
    resultsDir: stringField(raw.resultsDir) ?? inferCanvasSiblingPath(packageDir, "results"),
    createdAt: stringField(raw.createdAt) ?? new Date(0).toISOString(),
    updatedAt: stringField(raw.updatedAt) ?? new Date(0).toISOString()
  };
}

export function normalizeRegistry(input: unknown): TaskCanvasRegistry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Task canvas registry must be an object.");
  }
  const raw = input as RawTaskCanvasRegistry;
  if (raw.version !== registryVersion) {
    throw new Error(`Unsupported task canvas registry '${String(raw.version)}'.`);
  }
  if (!Array.isArray(raw.canvases)) {
    throw new Error("Task canvas registry canvases must be an array.");
  }
  const activeCanvasId = stringField(raw.activeCanvasId) ?? undefined;
  return {
    version: registryVersion,
    canvases: raw.canvases.map((record, index) => normalizeCanvasRecord(record, index)),
    activeCanvasId
  };
}
