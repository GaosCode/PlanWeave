import { access, chmod, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createOpencodeExecAdapter, runAutoRunStep } from "../index.js";
import { readJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForMetadataSession(metadataPath: string, expectedSessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await pathExists(metadataPath)) {
      const metadata = await readJsonFile(metadataPath);
      if ((metadata as { agentSessionId?: string }).agentSessionId === expectedSessionId) {
        return;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for metadata session ${expectedSessionId}`);
}

describe("OpenCode session capture", () => {
  it("records an explicit OpenCode session before command output is available", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode-session", {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--session", "ses_explicit_123", "--dangerously-skip-permissions", "-"]
      })
      .withDefaultExecutor("fake-opencode-session")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "opencode"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "fs.writeFileSync('opencode-session-argv.json', JSON.stringify(argv));",
        "setTimeout(() => { console.log('readable report after startup'); }, 500);"
      ].join("\n"),
      "utf8"
    );
    await chmod(join(root, "opencode"), 0o755);

    let stepSettled = false;
    const stepPromise = runAutoRunStep({
      projectRoot: init.workspace,
      executor: createOpencodeExecAdapter({
        projectRoot: init.workspace,
        executorName: "fake-opencode-session",
        runtime: { tmuxEnabled: false }
      })
    }).finally(() => {
      stepSettled = true;
    });

    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    let step: Awaited<typeof stepPromise>;
    try {
      await waitForMetadataSession(join(runDir, "metadata.json"), "ses_explicit_123");
      expect(stepSettled).toBe(false);
      step = await stepPromise;
    } catch (error) {
      await stepPromise.catch(() => undefined);
      throw error;
    }
    const expectedRoot = await realpath(root);
    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: { kind: "block", adapter: "opencode-exec", agentSessionId: "ses_explicit_123" }
    });
    await expect(readJsonFile(join(root, "opencode-session-argv.json"))).resolves.toEqual([
      "run",
      "--dir",
      expectedRoot,
      "--session",
      "ses_explicit_123",
      "--dangerously-skip-permissions",
      expect.stringContaining("Implement task")
    ]);
    const metadata = await readJsonFile<Record<string, unknown>>(join(runDir, "metadata.json"));
    expect(metadata).toMatchObject({
      agentSessionId: "ses_explicit_123",
      opencodeSessionId: "ses_explicit_123"
    });
    expect(metadata.tmuxSessionId).toBeUndefined();
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.not.toContain("opencode session list");
  });

  it("captures an OpenCode session id from streamed readable terminal output", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode-readable", {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--dangerously-skip-permissions", "-"]
      })
      .withDefaultExecutor("fake-opencode-readable")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "opencode"),
      [
        "#!/usr/bin/env node",
        "process.stderr.write('\\u001b[2m│\\u001b[0m Continue  opencode -s ses_default_456\\n');",
        "setTimeout(() => { console.log('readable report with terminal framing'); }, 500);"
      ].join("\n"),
      "utf8"
    );
    await chmod(join(root, "opencode"), 0o755);

    let stepSettled = false;
    const stepPromise = runAutoRunStep({
      projectRoot: init.workspace,
      executor: createOpencodeExecAdapter({
        projectRoot: init.workspace,
        executorName: "fake-opencode-readable",
        runtime: { tmuxEnabled: false }
      })
    }).finally(() => {
      stepSettled = true;
    });

    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    let step: Awaited<typeof stepPromise>;
    try {
      await waitForMetadataSession(join(runDir, "metadata.json"), "ses_default_456");
      expect(stepSettled).toBe(false);
      step = await stepPromise;
    } catch (error) {
      await stepPromise.catch(() => undefined);
      throw error;
    }
    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: { kind: "block", adapter: "opencode-exec", agentSessionId: "ses_default_456" }
    });
    await expect(readFile(join(runDir, "stderr.log"), "utf8")).resolves.toContain("opencode -s ses_default_456");
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.toContain("readable report with terminal framing");
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.not.toContain("opencode session list");
  });

  it("suggests OpenCode session list when readable output has no session id", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode-no-session", {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--dangerously-skip-permissions", "-"]
      })
      .withDefaultExecutor("fake-opencode-no-session")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "opencode"),
      ["#!/usr/bin/env node", "console.log('readable report without a visible session');"].join("\n"),
      "utf8"
    );
    await chmod(join(root, "opencode"), 0o755);

    const step = await runAutoRunStep({
      projectRoot: init.workspace,
      executor: createOpencodeExecAdapter({
        projectRoot: init.workspace,
        executorName: "fake-opencode-no-session",
        runtime: { tmuxEnabled: false }
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: { kind: "block", adapter: "opencode-exec", agentSessionId: null }
    });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.toContain("readable report without a visible session");
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.toContain("opencode session list");
  });
});
