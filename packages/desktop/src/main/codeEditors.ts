import { execFile, type ExecFileOptions } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 as windowsPath } from "node:path";
import { app, shell } from "electron";
import type {
  DesktopDevelopmentToolDetection,
  DesktopDevelopmentToolId,
  DesktopTerminalAppId
} from "@planweave-ai/runtime";
import { assertTerminalAppAvailable, detectTerminalApps } from "./terminalApps.js";
import { openTerminal } from "./terminalLauncher.js";

type ApplicationTool = {
  toolId: Exclude<DesktopDevelopmentToolId, DesktopTerminalAppId>;
  label: string;
  macOpenName: string;
  macBundleIds: readonly string[];
  executableName?: string;
  windowsExecutableNames?: readonly string[];
  windowsCommandExecutable?: {
    commandName: string;
    relativeExecutablePath: string;
  };
};

const applicationTools: ApplicationTool[] = [
  {
    toolId: "vscode",
    label: "VS Code",
    macOpenName: "Visual Studio Code",
    macBundleIds: ["com.microsoft.VSCode"],
    executableName: "code",
    windowsExecutableNames: ["Code.exe"],
    windowsCommandExecutable: {
      commandName: "code.cmd",
      relativeExecutablePath: "../Code.exe"
    }
  },
  {
    toolId: "cursor",
    label: "Cursor",
    macOpenName: "Cursor",
    macBundleIds: ["com.todesktop.230313mzl4w4u92"],
    executableName: "cursor",
    windowsExecutableNames: ["Cursor.exe"],
    windowsCommandExecutable: {
      commandName: "cursor.cmd",
      relativeExecutablePath: "../../../Cursor.exe"
    }
  },
  {
    toolId: "finder",
    label: "Finder",
    macOpenName: "Finder",
    macBundleIds: ["com.apple.finder"]
  },
  {
    toolId: "xcode",
    label: "Xcode",
    macOpenName: "Xcode",
    macBundleIds: ["com.apple.dt.Xcode"]
  },
  {
    toolId: "android-studio",
    label: "Android Studio",
    macOpenName: "Android Studio",
    macBundleIds: ["com.google.android.studio"]
  },
  {
    toolId: "goland",
    label: "GoLand",
    macOpenName: "GoLand",
    macBundleIds: ["com.jetbrains.goland"]
  },
  {
    toolId: "pycharm",
    label: "PyCharm",
    macOpenName: "PyCharm",
    macBundleIds: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"]
  }
];

const terminalToolIds = new Set<DesktopDevelopmentToolId>(["terminal", "iterm2", "ghostty"]);
const developmentToolOrder: readonly DesktopDevelopmentToolId[] = [
  "vscode",
  "cursor",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "xcode",
  "android-studio",
  "goland",
  "pycharm"
];
const applicationToolsById = new Map(applicationTools.map((tool) => [tool.toolId, tool] as const));
const detectedMacApplicationPaths = new Map<DesktopDevelopmentToolId, string>();
const executableOutputLine = /\r?\n/u;
const detectionOptions = { timeout: 2_000, maxBuffer: 64 * 1024 } as const;
const applicationPathDetectionOptions = { timeout: 5_000, maxBuffer: 256 * 1024 } as const;
/** Process-local TTL for successful development-tool detection (mdfind/path/icon/terminal). */
export const DEVELOPMENT_TOOL_DETECTION_TTL_MS = 5 * 60 * 1000;

type DevelopmentToolDetectionDeps = {
  now: () => number;
  detect: () => Promise<DesktopDevelopmentToolDetection[]>;
};

type DevelopmentToolDetectionCache = {
  expiresAt: number;
  inFlight: Promise<readonly DesktopDevelopmentToolDetection[]> | null;
  value: readonly DesktopDevelopmentToolDetection[] | null;
};

let developmentToolDetectionDeps: DevelopmentToolDetectionDeps = {
  now: () => Date.now(),
  detect: detectDevelopmentToolsUncached
};

let developmentToolDetectionCache: DevelopmentToolDetectionCache = {
  expiresAt: 0,
  inFlight: null,
  value: null
};

function cloneDevelopmentToolDetections(
  tools: readonly DesktopDevelopmentToolDetection[]
): DesktopDevelopmentToolDetection[] {
  return tools.map((tool) => ({ ...tool }));
}

function snapshotDevelopmentToolDetections(
  tools: readonly DesktopDevelopmentToolDetection[]
): readonly DesktopDevelopmentToolDetection[] {
  return Object.freeze(tools.map((tool) => Object.freeze({ ...tool })));
}

function execFileVoid(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...detectionOptions, ...options }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function execFileText(
  command: string,
  args: string[],
  options: typeof detectionOptions | typeof applicationPathDetectionOptions = detectionOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function isDesktopDevelopmentToolId(value: unknown): value is DesktopDevelopmentToolId {
  return typeof value === "string" && developmentToolOrder.some((toolId) => toolId === value);
}

function isTerminalToolId(toolId: DesktopDevelopmentToolId): toolId is DesktopTerminalAppId {
  return terminalToolIds.has(toolId);
}

function macBundleQuery(bundleIds: readonly string[]): string {
  return bundleIds.map((bundleId) => `kMDItemCFBundleIdentifier == '${bundleId}'`).join(" || ");
}

function preferredApplicationPath(paths: string[], macOpenName: string): string | null {
  const exactName = `${macOpenName}.app`;
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));
  return sortedPaths.find((path) => basename(path) === exactName) ?? sortedPaths[0] ?? null;
}

async function resolveApplicationPath(tool: ApplicationTool): Promise<string> {
  if (process.platform === "darwin") {
    const matches = await execFileText(
      "/usr/bin/mdfind",
      [macBundleQuery(tool.macBundleIds)],
      applicationPathDetectionOptions
    );
    const applicationPath = preferredApplicationPath(
      matches
        .split(executableOutputLine)
        .map((path) => path.trim())
        .filter((path) => path.endsWith(".app")),
      tool.macOpenName
    );
    if (!applicationPath) {
      throw new Error(`${tool.label} application bundle was not found.`);
    }
    return applicationPath;
  }
  if (!tool.executableName) {
    throw new Error(`${tool.label} is not supported on this platform.`);
  }
  if (process.platform === "win32") {
    for (const executableName of tool.windowsExecutableNames ?? [tool.executableName]) {
      try {
        const executable = await execFileText("where.exe", [executableName]);
        const firstMatch = executable.split(executableOutputLine).find(Boolean);
        if (firstMatch) return firstMatch;
      } catch {
        // Continue to the command-shim locator below without executing the shim.
      }
    }
    if (tool.windowsCommandExecutable) {
      const commandMatches = await execFileText("where.exe", [
        tool.windowsCommandExecutable.commandName
      ]);
      const commandPath = commandMatches.split(executableOutputLine).find(Boolean);
      if (commandPath) {
        const executablePath = windowsPath.resolve(
          windowsPath.dirname(commandPath),
          tool.windowsCommandExecutable.relativeExecutablePath
        );
        await access(executablePath);
        return executablePath;
      }
    }
    throw new Error(`${tool.label} executable was not found.`);
  }
  const executable = await execFileText("which", [tool.executableName]);
  const firstMatch = executable.split(executableOutputLine).find(Boolean);
  if (!firstMatch) throw new Error(`${tool.label} executable was not found.`);
  return firstMatch;
}

async function applicationIconDataUrl(
  iconPath: string
): Promise<{ iconDataUrl: string | null; iconUnavailableReason: string | null }> {
  const bundleIconDataUrl = await applicationBundleIconDataUrl(iconPath);
  if (bundleIconDataUrl) {
    return { iconDataUrl: bundleIconDataUrl, iconUnavailableReason: null };
  }
  try {
    const icon = await app.getFileIcon(iconPath, { size: "normal" });
    const iconDataUrl = icon.toDataURL();
    return iconDataUrl
      ? { iconDataUrl, iconUnavailableReason: null }
      : {
          iconDataUrl: null,
          iconUnavailableReason: `${iconPath} returned an empty native application icon.`
        };
  } catch (caught) {
    return { iconDataUrl: null, iconUnavailableReason: errorMessage(caught) };
  }
}

async function applicationBundleIconDataUrl(applicationPath: string): Promise<string | null> {
  if (process.platform !== "darwin" || !applicationPath.endsWith(".app")) {
    return null;
  }
  let tempDir: string | null = null;
  try {
    const rawIconFile = await execFileText(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIconFile", join(applicationPath, "Contents", "Info.plist")],
      applicationPathDetectionOptions
    );
    if (!rawIconFile) return null;
    const iconFile = rawIconFile.endsWith(".icns") ? rawIconFile : `${rawIconFile}.icns`;
    const iconFilePath = join(applicationPath, "Contents", "Resources", iconFile);
    tempDir = await mkdtemp(join(tmpdir(), "planweave-development-tool-icon-"));
    const outputPath = join(tempDir, "icon.png");
    await execFileVoid(
      "/usr/bin/sips",
      ["-z", "64", "64", "-s", "format", "png", iconFilePath, "--out", outputPath],
      { timeout: 5_000, maxBuffer: 256 * 1024 }
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

async function detectApplicationTool(
  tool: ApplicationTool
): Promise<DesktopDevelopmentToolDetection> {
  if (tool.toolId === "finder" && process.platform !== "darwin") {
    return {
      toolId: tool.toolId,
      label: process.platform === "win32" ? "File Explorer" : "File Manager",
      available: true,
      iconDataUrl: null,
      iconUnavailableReason: "The system file manager icon is unavailable.",
      unavailableReason: null
    };
  }
  try {
    const iconPath = await resolveApplicationPath(tool);
    if (process.platform === "darwin") {
      detectedMacApplicationPaths.set(tool.toolId, iconPath);
    }
    const icon = await applicationIconDataUrl(iconPath);
    return {
      toolId: tool.toolId,
      label: tool.label,
      available: true,
      ...icon,
      unavailableReason: null
    };
  } catch (caught) {
    if (process.platform === "darwin") {
      detectedMacApplicationPaths.delete(tool.toolId);
    }
    if (tool.toolId === "finder") {
      return {
        toolId: tool.toolId,
        label: tool.label,
        available: true,
        iconDataUrl: null,
        iconUnavailableReason: errorMessage(caught),
        unavailableReason: null
      };
    }
    return {
      toolId: tool.toolId,
      label: tool.label,
      available: false,
      iconDataUrl: null,
      iconUnavailableReason: null,
      unavailableReason: errorMessage(caught)
    };
  }
}

async function detectDevelopmentToolsUncached(): Promise<DesktopDevelopmentToolDetection[]> {
  const [applications, terminals] = await Promise.all([
    Promise.all(applicationTools.map(detectApplicationTool)),
    process.platform === "darwin" ? detectTerminalApps() : Promise.resolve([])
  ]);
  const detectedById = new Map<DesktopDevelopmentToolId, DesktopDevelopmentToolDetection>();
  for (const tool of applications) {
    detectedById.set(tool.toolId, tool);
  }
  for (const terminal of terminals) {
    detectedById.set(terminal.appId, {
      toolId: terminal.appId,
      label: terminal.label,
      available: terminal.available,
      iconDataUrl: terminal.iconDataUrl,
      iconUnavailableReason:
        terminal.available && !terminal.iconDataUrl
          ? `${terminal.label} native application icon is unavailable.`
          : null,
      unavailableReason: terminal.unavailableReason
    });
  }
  return developmentToolOrder.flatMap((toolId) => {
    const tool = detectedById.get(toolId);
    return tool ? [tool] : [];
  });
}

/**
 * Detect installed development tools with a process-local success TTL and in-flight dedupe.
 * Failures are not cached; callers receive immutable copies of the success snapshot.
 */
export async function detectDevelopmentTools(): Promise<DesktopDevelopmentToolDetection[]> {
  const { now, detect } = developmentToolDetectionDeps;
  const currentTime = now();
  if (
    developmentToolDetectionCache.value &&
    currentTime < developmentToolDetectionCache.expiresAt
  ) {
    return cloneDevelopmentToolDetections(developmentToolDetectionCache.value);
  }
  if (developmentToolDetectionCache.inFlight) {
    return developmentToolDetectionCache.inFlight.then(cloneDevelopmentToolDetections);
  }

  let inFlight!: Promise<readonly DesktopDevelopmentToolDetection[]>;
  inFlight = detect()
    .then((tools) => {
      const snapshot = snapshotDevelopmentToolDetections(tools);
      developmentToolDetectionCache = {
        expiresAt: now() + DEVELOPMENT_TOOL_DETECTION_TTL_MS,
        inFlight: null,
        value: snapshot
      };
      return snapshot;
    })
    .catch((error: unknown) => {
      if (developmentToolDetectionCache.inFlight === inFlight) {
        developmentToolDetectionCache = {
          ...developmentToolDetectionCache,
          inFlight: null
        };
      }
      throw error;
    });
  developmentToolDetectionCache = {
    ...developmentToolDetectionCache,
    inFlight
  };
  return inFlight.then(cloneDevelopmentToolDetections);
}

export function resetDevelopmentToolDetectionCacheForTests(): void {
  developmentToolDetectionCache = {
    expiresAt: 0,
    inFlight: null,
    value: null
  };
  detectedMacApplicationPaths.clear();
  developmentToolDetectionDeps = {
    now: () => Date.now(),
    detect: detectDevelopmentToolsUncached
  };
}

export function setDevelopmentToolDetectionDepsForTests(
  deps: Partial<DevelopmentToolDetectionDeps>
): void {
  developmentToolDetectionDeps = {
    now: deps.now ?? developmentToolDetectionDeps.now,
    detect: deps.detect ?? developmentToolDetectionDeps.detect
  };
}

export function setDetectedMacApplicationPathForTests(
  toolId: DesktopDevelopmentToolId,
  applicationPath: string | null
): void {
  if (applicationPath === null) {
    detectedMacApplicationPaths.delete(toolId);
    return;
  }
  detectedMacApplicationPaths.set(toolId, applicationPath);
}

async function assertPathAvailable(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is no longer available at ${path}.`);
  }
}

async function resolveLaunchApplicationPath(tool: ApplicationTool): Promise<string> {
  if (process.platform === "darwin") {
    const cachedPath = detectedMacApplicationPaths.get(tool.toolId);
    if (cachedPath) {
      try {
        await access(cachedPath);
        return cachedPath;
      } catch {
        detectedMacApplicationPaths.delete(tool.toolId);
      }
    }
    const applicationPath = await resolveApplicationPath(tool);
    await assertPathAvailable(applicationPath, tool.label);
    detectedMacApplicationPaths.set(tool.toolId, applicationPath);
    return applicationPath;
  }
  if (!tool.executableName) {
    throw new Error(`${tool.label} is not supported on this platform.`);
  }
  const executablePath = await resolveApplicationPath(tool);
  await assertPathAvailable(executablePath, tool.label);
  return executablePath;
}

export async function openProjectInDevelopmentTool(
  rootPath: string,
  toolId: DesktopDevelopmentToolId
): Promise<void> {
  if (isTerminalToolId(toolId)) {
    await assertTerminalAppAvailable(toolId);
    await openTerminal(toolId, { cwd: rootPath });
    return;
  }
  const tool = applicationToolsById.get(toolId);
  if (!tool) {
    throw new Error(`Unsupported development tool '${toolId}'.`);
  }
  if (tool.toolId === "finder") {
    const failure = await shell.openPath(rootPath);
    if (failure) throw new Error(failure);
    return;
  }
  if (process.platform === "darwin") {
    const applicationPath = await resolveLaunchApplicationPath(tool);
    await execFileVoid("/usr/bin/open", ["-a", applicationPath, rootPath]);
    return;
  }
  const executablePath = await resolveLaunchApplicationPath(tool);
  await execFileVoid(executablePath, [rootPath]);
}
