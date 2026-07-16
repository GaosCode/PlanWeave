import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { app } from "electron";
import type {
  DesktopTerminalAppDetection,
  DesktopTerminalAppId,
  DesktopTerminalPreferences
} from "@planweave-ai/runtime";
import { desktopHomePaths } from "./planweaveHomePaths.js";

export type TerminalApp = {
  appId: DesktopTerminalAppId;
  label: string;
  macOpenName: string;
  defaultPath: string | null;
  iconFile: string | null;
};

const terminalApps: TerminalApp[] = [
  {
    appId: "terminal",
    label: "Terminal",
    macOpenName: "Terminal",
    defaultPath: "/System/Applications/Utilities/Terminal.app",
    iconFile: "Terminal.icns"
  },
  {
    appId: "iterm2",
    label: "iTerm2",
    macOpenName: "iTerm",
    defaultPath: "/Applications/iTerm.app",
    iconFile: "iTerm2 App Icon for Release.icns"
  },
  {
    appId: "ghostty",
    label: "Ghostty",
    macOpenName: "Ghostty",
    defaultPath: "/Applications/Ghostty.app",
    iconFile: "Ghostty.icns"
  }
];

const terminalAppIds = new Set<DesktopTerminalAppId>(
  terminalApps.map((terminalApp) => terminalApp.appId)
);

/** Process-local TTL for successful terminal-app detection (open -Ra + icons). */
export const TERMINAL_APP_DETECTION_TTL_MS = 5 * 60 * 1000;

type TerminalAppDetectionDeps = {
  now: () => number;
  detect: () => Promise<DesktopTerminalAppDetection[]>;
};

type TerminalAppDetectionCache = {
  expiresAt: number;
  inFlight: Promise<readonly DesktopTerminalAppDetection[]> | null;
  value: readonly DesktopTerminalAppDetection[] | null;
};

let terminalAppDetectionDeps: TerminalAppDetectionDeps = {
  now: () => Date.now(),
  detect: detectTerminalAppsUncached
};

let terminalAppDetectionCache: TerminalAppDetectionCache = {
  expiresAt: 0,
  inFlight: null,
  value: null
};

function cloneTerminalAppDetections(
  apps: readonly DesktopTerminalAppDetection[]
): DesktopTerminalAppDetection[] {
  return apps.map((app) => ({ ...app }));
}

function snapshotTerminalAppDetections(
  apps: readonly DesktopTerminalAppDetection[]
): readonly DesktopTerminalAppDetection[] {
  return Object.freeze(apps.map((app) => Object.freeze({ ...app })));
}

function execFileVoid(command: string, args: string[], timeout = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 64 * 1024 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function errorCode(caught: unknown): string | null {
  if (!caught || typeof caught !== "object" || !("code" in caught)) {
    return null;
  }
  const code = (caught as Record<"code", unknown>).code;
  return typeof code === "string" ? code : null;
}

export function isDesktopTerminalAppId(value: unknown): value is DesktopTerminalAppId {
  return typeof value === "string" && terminalAppIds.has(value as DesktopTerminalAppId);
}

export function terminalAppById(appId: DesktopTerminalAppId): TerminalApp {
  const terminalApp = terminalApps.find((candidate) => candidate.appId === appId);
  if (!terminalApp) {
    throw new Error(`Unsupported terminal app '${appId}'.`);
  }
  return terminalApp;
}

async function appIconDataUrl(terminalApp: TerminalApp): Promise<string | null> {
  if (!terminalApp.defaultPath) {
    return null;
  }
  const bundleIcon = await appBundleIconDataUrl(terminalApp);
  if (bundleIcon) {
    return bundleIcon;
  }
  try {
    const icon = await app.getFileIcon(terminalApp.defaultPath, { size: "normal" });
    const dataUrl = icon.toDataURL();
    return dataUrl || null;
  } catch {
    return null;
  }
}

async function appBundleIconDataUrl(terminalApp: TerminalApp): Promise<string | null> {
  if (process.platform !== "darwin" || !terminalApp.defaultPath || !terminalApp.iconFile) {
    return null;
  }
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "planweave-terminal-icon-"));
    const outputPath = join(tempDir, `${terminalApp.appId}.png`);
    const iconPath = join(terminalApp.defaultPath, "Contents", "Resources", terminalApp.iconFile);
    await execFileVoid(
      "/usr/bin/sips",
      ["-z", "64", "64", "-s", "format", "png", iconPath, "--out", outputPath],
      5_000
    );
    const png = await readFile(outputPath);
    return png.length > 0 ? `data:image/png;base64,${png.toString("base64")}` : null;
  } catch {
    return null;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function detectTerminalApp(terminalApp: TerminalApp): Promise<DesktopTerminalAppDetection> {
  try {
    await execFileVoid("/usr/bin/open", ["-Ra", terminalApp.macOpenName]);
    return {
      appId: terminalApp.appId,
      label: terminalApp.label,
      available: true,
      iconDataUrl: await appIconDataUrl(terminalApp),
      unavailableReason: null
    };
  } catch (caught) {
    return {
      appId: terminalApp.appId,
      label: terminalApp.label,
      available: false,
      iconDataUrl: null,
      unavailableReason: errorMessage(caught)
    };
  }
}

async function detectTerminalAppsUncached(): Promise<DesktopTerminalAppDetection[]> {
  return Promise.all(terminalApps.map(detectTerminalApp));
}

/**
 * Detect installed terminal apps with a process-local success TTL and in-flight dedupe.
 * Failures are not cached; empty successful results are cached as normal detections.
 */
export async function detectTerminalApps(): Promise<DesktopTerminalAppDetection[]> {
  const { now, detect } = terminalAppDetectionDeps;
  const currentTime = now();
  if (terminalAppDetectionCache.value && currentTime < terminalAppDetectionCache.expiresAt) {
    return cloneTerminalAppDetections(terminalAppDetectionCache.value);
  }
  if (terminalAppDetectionCache.inFlight) {
    return terminalAppDetectionCache.inFlight.then(cloneTerminalAppDetections);
  }

  let inFlight!: Promise<readonly DesktopTerminalAppDetection[]>;
  inFlight = detect()
    .then((apps) => {
      const snapshot = snapshotTerminalAppDetections(apps);
      terminalAppDetectionCache = {
        expiresAt: now() + TERMINAL_APP_DETECTION_TTL_MS,
        inFlight: null,
        value: snapshot
      };
      return snapshot;
    })
    .catch((error: unknown) => {
      if (terminalAppDetectionCache.inFlight === inFlight) {
        terminalAppDetectionCache = {
          ...terminalAppDetectionCache,
          inFlight: null
        };
      }
      throw error;
    });
  terminalAppDetectionCache = {
    ...terminalAppDetectionCache,
    inFlight
  };
  return inFlight.then(cloneTerminalAppDetections);
}

export function resetTerminalAppDetectionCacheForTests(): void {
  terminalAppDetectionCache = {
    expiresAt: 0,
    inFlight: null,
    value: null
  };
  terminalAppDetectionDeps = {
    now: () => Date.now(),
    detect: detectTerminalAppsUncached
  };
}

export function setTerminalAppDetectionDepsForTests(deps: Partial<TerminalAppDetectionDeps>): void {
  terminalAppDetectionDeps = {
    now: deps.now ?? terminalAppDetectionDeps.now,
    detect: deps.detect ?? terminalAppDetectionDeps.detect
  };
}

export async function assertTerminalAppAvailable(
  appId: DesktopTerminalAppId
): Promise<TerminalApp> {
  const terminalApp = terminalAppById(appId);
  try {
    await execFileVoid("/usr/bin/open", ["-Ra", terminalApp.macOpenName]);
    return terminalApp;
  } catch {
    throw new Error("Terminal app is not installed.");
  }
}

function preferencesPath(): string {
  return desktopHomePaths().terminalPreferencesFile;
}

function legacyPreferencesPath(): string {
  return join(app.getPath("userData"), "terminal-preferences.json");
}

function defaultTerminalPreferences(): DesktopTerminalPreferences {
  return {
    defaultTerminalAppId: null
  };
}

function parseTerminalPreferences(raw: unknown): DesktopTerminalPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Terminal preferences must be a JSON object.");
  }
  const defaultTerminalAppId = (raw as Record<"defaultTerminalAppId", unknown>)
    .defaultTerminalAppId;
  if (defaultTerminalAppId !== null && !isDesktopTerminalAppId(defaultTerminalAppId)) {
    throw new Error("Terminal preferences defaultTerminalAppId is invalid.");
  }
  return {
    defaultTerminalAppId
  };
}

export async function getTerminalPreferences(): Promise<DesktopTerminalPreferences> {
  try {
    const raw = JSON.parse(await readFile(preferencesPath(), "utf8")) as unknown;
    return parseTerminalPreferences(raw);
  } catch (caught) {
    if (errorCode(caught) !== "ENOENT") {
      throw caught;
    }
  }

  try {
    const legacyPreferences = parseTerminalPreferences(
      JSON.parse(await readFile(legacyPreferencesPath(), "utf8")) as unknown
    );
    await writeTerminalPreferences(legacyPreferences);
    return legacyPreferences;
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") {
      return defaultTerminalPreferences();
    }
    throw caught;
  }
}

function validateTerminalPreferencesPatch(
  patch: Partial<DesktopTerminalPreferences>
): Partial<DesktopTerminalPreferences> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Terminal preferences patch must be a JSON object.");
  }
  for (const key of Object.keys(patch)) {
    if (key !== "defaultTerminalAppId") {
      throw new Error(`Unsupported terminal preferences field '${key}'.`);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, "defaultTerminalAppId") &&
    patch.defaultTerminalAppId !== null &&
    !isDesktopTerminalAppId(patch.defaultTerminalAppId)
  ) {
    throw new Error("Terminal preferences defaultTerminalAppId is invalid.");
  }
  return patch;
}

async function writeTerminalPreferences(preferences: DesktopTerminalPreferences): Promise<void> {
  const path = preferencesPath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export async function updateTerminalPreferences(
  patch: Partial<DesktopTerminalPreferences>
): Promise<DesktopTerminalPreferences> {
  const current = await getTerminalPreferences();
  const validPatch = validateTerminalPreferencesPatch(patch);
  const next = {
    ...current,
    ...validPatch
  };
  await writeTerminalPreferences(next);
  return next;
}
