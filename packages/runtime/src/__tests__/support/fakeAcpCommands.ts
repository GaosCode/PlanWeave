import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture } from "./acpRunnerLifecycleFixture.js";

const defaultCommands = ["codex-acp", "claude-agent-acp", "opencode", "pi-acp", "grok"] as const;

export async function installFakeAcpCommands(
  scenario = "artifact-implementation",
  commands: readonly string[] = defaultCommands
): Promise<{ bin: string; restore: () => void }> {
  const bin = await mkdtemp(join(tmpdir(), "planweave-fake-acp-bin-"));
  const script = `#!/usr/bin/env node\nprocess.argv[2] = ${JSON.stringify(scenario)};\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`;
  await Promise.all(
    commands.map(async (command) => {
      const path = join(bin, command);
      await writeFile(path, script, "utf8");
      await chmod(path, 0o755);
    })
  );
  const previousPath = process.env.PATH;
  process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);
  return {
    bin,
    restore() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  };
}
