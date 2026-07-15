import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinAgentProfiles } from "../autoRun/agentRegistry.js";
import {
  applyDesktopAgentSettingsToBuiltinProfiles,
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
    expect(profiles.grok).toBeUndefined();
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
    expect(profiles.grok).toBeUndefined();
    expect(profiles["grok-acp"]).toMatchObject({ runner: { transport: "acp" } });
  });
});
