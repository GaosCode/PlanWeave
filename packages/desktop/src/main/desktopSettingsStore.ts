import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  defaultDesktopSettings,
  mergeDesktopSettings,
  normalizeDesktopSettings,
  parseLegacyDesktopSettingsPayload,
  type DesktopSettingsPatch,
  type DesktopUiSettings
} from "../shared/desktopSettings.js";
import { desktopHomePaths } from "./planweaveHomePaths.js";

export type DesktopSettingsStoreErrorCode = "invalid_json" | "invalid_legacy_payload";

export class DesktopSettingsStoreError extends Error {
  readonly code: DesktopSettingsStoreErrorCode;
  readonly settingsFile: string;
  readonly cause: unknown;

  constructor(code: DesktopSettingsStoreErrorCode, settingsFile: string, message: string, cause: unknown) {
    super(message);
    this.name = "DesktopSettingsStoreError";
    this.code = code;
    this.settingsFile = settingsFile;
    this.cause = cause;
  }
}

function errorCode(caught: unknown): string | null {
  if (!caught || typeof caught !== "object" || !("code" in caught)) {
    return null;
  }
  const code = (caught as Record<"code", unknown>).code;
  return typeof code === "string" ? code : null;
}

async function writeJsonAtomically(path: string, value: DesktopUiSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExplicitWindowMaterialPreference(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.windowMaterial)) {
    return false;
  }
  return typeof value.windowMaterial.enabled === "boolean";
}

function applyMacosMaterialDefault(settings: DesktopUiSettings, platform: NodeJS.Platform): DesktopUiSettings {
  if (platform !== "darwin" || settings.windowMaterial.enabled) {
    return settings;
  }
  return mergeDesktopSettings(settings, { windowMaterial: { enabled: true } });
}

type DesktopSettingsStoreOptions = {
  settingsFile?: string;
  platform?: NodeJS.Platform;
};

export class DesktopSettingsStore {
  readonly settingsFile: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: string | DesktopSettingsStoreOptions = {}) {
    const resolvedOptions = typeof options === "string" ? { settingsFile: options } : options;
    this.settingsFile = resolvedOptions.settingsFile ?? desktopHomePaths().desktopSettingsFile;
    this.platform = resolvedOptions.platform ?? process.platform;
  }

  private initialSettings(): DesktopUiSettings {
    return applyMacosMaterialDefault(defaultDesktopSettings, this.platform);
  }

  async read(): Promise<DesktopUiSettings> {
    let raw: string;
    try {
      raw = await readFile(this.settingsFile, "utf8");
    } catch (caught) {
      if (errorCode(caught) === "ENOENT") {
        return this.initialSettings();
      }
      throw caught;
    }

    try {
      return normalizeDesktopSettings(JSON.parse(raw) as unknown);
    } catch (caught) {
      throw new DesktopSettingsStoreError("invalid_json", this.settingsFile, `Desktop settings file contains invalid JSON: ${this.settingsFile}`, caught);
    }
  }

  async write(next: DesktopUiSettings): Promise<DesktopUiSettings> {
    const normalized = normalizeDesktopSettings(next);
    await writeJsonAtomically(this.settingsFile, normalized);
    return normalized;
  }

  async mergePatch(patch: DesktopSettingsPatch): Promise<DesktopUiSettings> {
    const current = await this.read();
    const next = normalizeDesktopSettings(mergeDesktopSettings(current, patch));
    await writeJsonAtomically(this.settingsFile, next);
    return next;
  }

  async migrateLegacy(payload: unknown): Promise<DesktopUiSettings> {
    let next: DesktopUiSettings;
    try {
      const parsedPayload = parseLegacyDesktopSettingsPayload(payload);
      next = normalizeDesktopSettings(parsedPayload);
      if (!hasExplicitWindowMaterialPreference(parsedPayload)) {
        next = applyMacosMaterialDefault(next, this.platform);
      }
    } catch (caught) {
      throw new DesktopSettingsStoreError(
        "invalid_legacy_payload",
        this.settingsFile,
        "Legacy desktop settings payload contains invalid JSON.",
        caught
      );
    }
    await writeJsonAtomically(this.settingsFile, next);
    return next;
  }
}
