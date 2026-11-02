import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinAgentProfiles } from "../autoRun/agentRegistry.js";
import { isBuiltinExecutorName } from "../executorNames.js";
import {
  applyDesktopAgentSettingsToBuiltinProfiles,
  selectedDesktopAgentHost,
  selectedDesktopAgentTransport
} from "../autoRun/desktopAgentSettings.js";

const originalSettingsFile = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (originalSettingsFile === undefined) {
    delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  } else {
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettingsFile;
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function writeSettings(value: unknown): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "planweave-agent-transport-"));
  temporaryRoots.push(root);
  const settingsFile = join(root, "desktop-settings.json");
  await writeFile(settingsFile, `${JSON.stringify(value)}\n`, "utf8");
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = settingsFile;
}

describe("desktop agent transport settings", () => {
  it.each([
    "cli",
    "acp"
  ])("offers only registered builtin profiles with %s transport", async (agentTransport) => {
    await writeSettings({ execution: { agentTransport } });
    const profiles = applyDesktopAgentSettingsToBuiltinProfiles(builtinAgentProfiles());

    for (const name of Object.keys(profiles)) {
      expect(isBuiltinExecutorName(name), `Unregistered builtin executor '${name}'`).toBe(true);
    }
  });

  it("maps canonical builtin agent names to ACP without rewriting explicit legacy profiles", async () => {
    await writeSettings({ execution: { agentTransport: "acp" } });

    const profiles = applyDesktopAgentSettingsToBuiltinProfiles(builtinAgentProfiles());

    expect(selectedDesktopAgentTransport()).toBe("acp");
    expect(profiles.codex).toMatchObject({
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    });
    expect(profiles["codex-acp"]).toMatchObject({
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    });
    expect(profiles["codex-auto"]).toMatchObject({ runner: { transport: "cli" } });
    expect(profiles.grok).toMatchObject({
      adapter: "agent",
      agent: "grok",
      runner: { transport: "acp" }
    });
    expect(profiles["grok-acp"]).toMatchObject({
      adapter: "agent",
      agent: "grok",
      runner: { transport: "acp" }
    });
  });

  it("defaults missing and invalid transport settings to ACP", async () => {
    await writeSettings({ execution: { agentTransport: "unsupported" } });

    const profiles = applyDesktopAgentSettingsToBuiltinProfiles(builtinAgentProfiles());

    expect(selectedDesktopAgentTransport()).toBe("acp");
    expect(profiles.codex).toMatchObject({ runner: { transport: "acp" } });
  });

  it("preserves an explicit CLI transport selection", async () => {
    await writeSettings({ execution: { agentTransport: "cli" } });

    const profiles = applyDesktopAgentSettingsToBuiltinProfiles(builtinAgentProfiles());

    expect(selectedDesktopAgentTransport()).toBe("cli");
    expect(profiles.codex).toMatchObject({ runner: { transport: "cli" } });
    expect(profiles.grok).toMatchObject({
      adapter: "agent",
      agent: "grok",
      runner: { transport: "cli" },
      args: ["--no-auto-update", "--prompt-file"]
    });
    expect(profiles["grok-acp"]).toMatchObject({ runner: { transport: "acp" } });
  });

  it("applies the selected host to builtins and defaults invalid settings to native", async () => {
    await writeSettings({
      execution: {
        agentTransport: "acp",
        agentHost: { kind: "wsl", distribution: " Ubuntu " }
      }
    });

    const profiles = applyDesktopAgentSettingsToBuiltinProfiles(builtinAgentProfiles());

    expect(selectedDesktopAgentHost()).toEqual({ kind: "wsl", distribution: "Ubuntu" });
    expect(profiles.codex).toMatchObject({
      runner: { transport: "acp" },
      host: { kind: "wsl", distribution: "Ubuntu" }
    });
    expect(profiles["codex-auto"]).toMatchObject({
      runner: { transport: "cli" },
      host: { kind: "wsl", distribution: "Ubuntu" }
    });

    await writeSettings({
      execution: { agentHost: { kind: "wsl", distribution: "" } }
    });
    expect(selectedDesktopAgentHost()).toEqual({ kind: "native" });
  });

  it("applies the explicit full-access setting to Grok CLI only", async () => {
    await writeSettings({
      execution: { agentTransport: "cli" },
      agents: { grok: { enabled: true, fullAccess: true } }
    });

    const profiles = applyDesktopAgentSettingsToBuiltinProfiles(builtinAgentProfiles());

    expect(profiles.grok).toMatchObject({
      runner: { transport: "cli" },
      args: ["--always-approve", "--no-auto-update", "--prompt-file"]
    });
    expect(profiles["grok-acp"]).toMatchObject({ runner: { transport: "acp" } });
  });
});
