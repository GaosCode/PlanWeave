import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutorProfile } from "../types.js";

type DesktopAgentKind = "codex" | "claude-code" | "opencode" | "pi";

type DesktopAgentRuntimeSetting = {
  enabled?: boolean;
  fullAccess?: boolean;
};

type DesktopAgentSettings = Partial<Record<DesktopAgentKind, DesktopAgentRuntimeSetting>>;

const desktopAgentNames = {
  codex: ["codex", "codex-auto"],
  "claude-code": ["claude-code", "claude-code-auto"],
  opencode: ["opencode"],
  pi: ["pi", "pi-auto"]
} as const satisfies Record<DesktopAgentKind, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function desktopSettingsFile(): string {
  const override = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  return override
    ? resolve(override)
    : join(homedir(), ".planweave", "config", "desktop-settings.json");
}

function readDesktopAgentSettings(): DesktopAgentSettings | null {
  const settingsFile = desktopSettingsFile();
  let raw: string;
  try {
    raw = readFileSync(settingsFile, "utf8");
  } catch (caught) {
    if (isRecord(caught) && caught.code === "ENOENT") {
      return null;
    }
    throw caught;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`Desktop settings file contains invalid JSON: ${settingsFile}: ${reason}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.agents)) {
    return null;
  }

  const agents: DesktopAgentSettings = {};
  for (const kind of Object.keys(desktopAgentNames) as DesktopAgentKind[]) {
    const value = parsed.agents[kind];
    if (!isRecord(value)) {
      continue;
    }
    agents[kind] = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
      fullAccess: typeof value.fullAccess === "boolean" ? value.fullAccess : undefined
    };
  }
  return agents;
}

function fullAccessEnabled(settings: DesktopAgentSettings | null, kind: DesktopAgentKind): boolean {
  const agent = settings?.[kind];
  return agent?.enabled === true && agent.fullAccess === true;
}

function addArgOnce(args: readonly string[], arg: string): string[] {
  if (args.includes(arg)) {
    return [...args];
  }
  return [arg, ...args];
}

export function applyDesktopAgentSettingsToBuiltinProfiles(
  profiles: Record<string, ExecutorProfile>
): Record<string, ExecutorProfile> {
  const settings = readDesktopAgentSettings();
  if (!settings) {
    return profiles;
  }

  const next: Record<string, ExecutorProfile> = { ...profiles };
  if (fullAccessEnabled(settings, "codex")) {
    for (const name of desktopAgentNames.codex) {
      const profile = next[name];
      if (
        profile?.adapter === "agent" &&
        profile.agent === "codex" &&
        "command" in profile
      ) {
        next[name] = { ...profile, sandbox: "danger-full-access" };
      }
    }
  }
  if (fullAccessEnabled(settings, "opencode")) {
    for (const name of desktopAgentNames.opencode) {
      const profile = next[name];
      if (
        profile?.adapter === "agent" &&
        profile.agent === "opencode" &&
        "command" in profile
      ) {
        next[name] = { ...profile, sandbox: "danger-full-access" };
      }
    }
  }
  if (fullAccessEnabled(settings, "claude-code")) {
    for (const name of desktopAgentNames["claude-code"]) {
      const profile = next[name];
      if (
        profile?.adapter === "agent" &&
        profile.agent === "claude-code" &&
        "command" in profile
      ) {
        next[name] = {
          ...profile,
          args: addArgOnce(profile.args, "--dangerously-skip-permissions")
        };
      }
    }
  }
  return next;
}
