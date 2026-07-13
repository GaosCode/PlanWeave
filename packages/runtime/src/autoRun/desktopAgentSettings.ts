import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutorProfile, RunnerTransport } from "../types.js";

type DesktopAgentKind = "codex" | "claude-code" | "opencode" | "pi";

type DesktopAgentRuntimeSetting = {
  enabled?: boolean;
  fullAccess?: boolean;
};

type DesktopAgentSettings = Partial<Record<DesktopAgentKind, DesktopAgentRuntimeSetting>>;

type DesktopAgentRuntimeSettings = {
  agentTransport: RunnerTransport;
  agents: DesktopAgentSettings;
};

const desktopAgentNames = {
  codex: ["codex", "codex-auto"],
  "claude-code": ["claude-code", "claude-code-auto"],
  opencode: ["opencode"],
  pi: ["pi", "pi-auto"]
} as const satisfies Record<DesktopAgentKind, readonly string[]>;

const desktopAgentAcpNames = {
  codex: "codex-acp",
  "claude-code": "claude-code-acp",
  opencode: "opencode-acp",
  pi: "pi-acp"
} as const satisfies Record<DesktopAgentKind, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function desktopSettingsFile(): string {
  const override = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  return override
    ? resolve(override)
    : join(homedir(), ".planweave", "config", "desktop-settings.json");
}

function readDesktopAgentSettings(): DesktopAgentRuntimeSettings | null {
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

  if (!isRecord(parsed)) {
    return null;
  }

  const agents: DesktopAgentSettings = {};
  if (isRecord(parsed.agents)) {
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
  }
  const configuredTransport = isRecord(parsed.execution)
    ? parsed.execution.agentTransport
    : undefined;
  return {
    agentTransport: configuredTransport === "acp" ? "acp" : "cli",
    agents
  };
}

function fullAccessEnabled(settings: DesktopAgentSettings | null, kind: DesktopAgentKind): boolean {
  const agent = settings?.[kind];
  return agent?.enabled === true && agent.fullAccess === true;
}

export function selectedDesktopAgentTransport(): RunnerTransport {
  return readDesktopAgentSettings()?.agentTransport ?? "cli";
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
  if (settings.agentTransport === "acp") {
    for (const kind of Object.keys(desktopAgentAcpNames) as DesktopAgentKind[]) {
      const acpProfile = next[desktopAgentAcpNames[kind]];
      if (acpProfile) {
        next[kind] = acpProfile;
      }
    }
  }
  if (settings.agentTransport === "cli" && fullAccessEnabled(settings.agents, "codex")) {
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
  if (settings.agentTransport === "cli" && fullAccessEnabled(settings.agents, "opencode")) {
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
  if (
    settings.agentTransport === "cli" &&
    fullAccessEnabled(settings.agents, "claude-code")
  ) {
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
