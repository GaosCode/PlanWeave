import { z } from "zod";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initWorkspace } from "../../../../runtime/src/initWorkspace.js";
import {
  basicManifest,
  writePromptFiles
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { writeJsonFile } from "../../../../runtime/src/json.js";
import {
  canonicalProjectCanvasNode,
  writeProjectGraph
} from "../../../../runtime/src/projectGraph/index.js";
import { acpProfileCatalogSchema } from "../../../../runtime/src/acpProfile/schema.js";
import {
  CatalogAcpProfileResolver,
  ExecutionHostAcpCommandResolver
} from "../../../../runtime/src/acpProfile/resolver.js";
import { AcpProfileStore } from "../../../../runtime/src/acpProfile/store.js";
import { gateAcpCapabilities } from "../../../../runtime/src/autoRun/acpCapabilityGate.js";
import { normalizedRunnerEventSchema } from "../../../../runtime/src/autoRun/normalizedEventContract.js";
import { trustCommand } from "../../../../runtime/src/taskManager/hookTrustStore.js";
import { rebuildBlockRunIndex } from "../../../../runtime/src/autoRun/blockRunIndex.js";
import { getRunRecord } from "../../../../runtime/src/desktop/recordsApi.js";

const agent = fileURLToPath(
  new URL("../../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);

/** Creates only owned temporary data; never starts an installed Desktop or a model provider. */
export async function createTaskWorkspaceAcpSmokeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-task-workspace-acp-"));
  const home = join(directory, "home");
  const root = join(directory, "repository");
  await mkdir(root);
  process.env.PLANWEAVE_HOME = home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "desktop-settings.json");
  const init = await initWorkspace({ projectRoot: root });
  const manifest = basicManifest();
  manifest.project.title = "Isolated ACP composer lifecycle";
  manifest.executors = Object.fromEntries(
    ["a", "b"].map((name) => [
      `smoke-${name}`,
      {
        adapter: "agent" as const,
        agent: "codex" as const,
        runner: { transport: "acp" as const, profileId: `smoke-${name}` }
      }
    ])
  );
  await writeJsonFile(init.workspace.manifestFile, manifest);
  await writePromptFiles(init.workspace.packageDir, manifest);
  await writeProjectGraph(init.workspace, {
    version: "plan-project/v1",
    canvases: [canonicalProjectCanvasNode({ id: "default", title: manifest.project.title })],
    edges: [],
    crossTaskEdges: []
  });
  const catalog = acpProfileCatalogSchema.parse({
    version: "planweave.acp-profile-catalog/v1",
    revision: 1,
    profiles: ["a", "b"].map((name) => ({
      version: "planweave.acp-profile/v1",
      id: `smoke-${name}`,
      agentId: "codex",
      displayName: `Local controlled ACP ${name.toUpperCase()}`,
      host: { kind: "native" },
      launch: {
        command: process.execPath,
        args: [agent, "load-capable", "--control-dir", join(directory, name)]
      },
      environment: [],
      shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1000 },
      capabilities: { required: [], optional: ["history-load"] },
      connection: { mode: "dedicated" }
    }))
  });
  await writeJsonFile(join(home, "config", "acp-profiles.json"), catalog);
  const resolver = new CatalogAcpProfileResolver(
    new AcpProfileStore(),
    new ExecutionHostAcpCommandResolver()
  );
  const runs = [];
  for (const [index, name] of ["a", "b"].entries()) {
    const runId = `RUN-00${index + 1}`;
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", runId);
    const controlDir = join(directory, name);
    await mkdir(runDir, { recursive: true });
    await mkdir(controlDir);
    const profile = await resolver.inspect(
      { agentId: "codex", profileId: `smoke-${name}` },
      { projectRoot: init.workspace, host: { kind: "native" } }
    );
    await trustCommand(init.workspace, profile.launch.command, [...profile.launch.args], {
      profileFingerprint: profile.fingerprint
    });
    const timestamp = `2026-10-20T00:00:0${index + 1}.000Z`;
    const sessionId = `smoke-session-${name}`;
    const identity = {
      projectId: init.workspace.id,
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: runId
    };
    const events = [
      {
        kind: "message",
        role: "assistant",
        messageId: `original-${name}`,
        chunk: false,
        content: `Completed local fixture ${name}`,
        redaction: { classes: [], replaced: 0 }
      },
      {
        kind: "terminal",
        outcome: {
          version: "planweave.runner/v1",
          state: "succeeded",
          reason: "completed",
          cleanup: { status: "succeeded" },
          exitCode: 0,
          finishedAt: timestamp,
          diagnostic: null,
          artifactValidated: true
        }
      }
    ].map((body, sequence) =>
      normalizedRunnerEventSchema.parse({
        version: "planweave.runner-event/v1",
        sequence: sequence + 1,
        timestamp,
        identity,
        runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
        correlation: { sessionId },
        body
      })
    );
    await writeFile(
      join(runDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n"
    );
    await writeFile(join(runDir, "report.md"), `Completed local fixture ${name}\n`);
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId,
      executorRunId: runId,
      ref: "T-001#B-001",
      claimRef: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      executor: `smoke-${name}`,
      executorProfile: `smoke-${name}`,
      agentId: "codex",
      runnerKind: "acp",
      adapter: "acp",
      status: "completed",
      outcome: "succeeded",
      sessionId,
      capabilities: { loadSession: true },
      startedAt: timestamp,
      finishedAt: timestamp,
      submittedAt: timestamp,
      executionCwd: root,
      acpCapabilitySnapshot: gateAcpCapabilities(
        profile.capabilities,
        {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "local-smoke", version: "1" }
        },
        { sessionStart: "new", connectionMode: "dedicated" }
      ),
      acpProfile: {
        profileId: profile.profileId,
        fingerprint: profile.fingerprint,
        source: profile.source,
        host: profile.host,
        environmentNames: [],
        missingEnvironmentNames: []
      }
    });
    const recordId = `T-001#B-001::${runId}`;
    const record = await getRunRecord(init.workspace, recordId);
    const promptIdentity = record.runnerReadModel?.intervention.prompt.identity;
    if (!promptIdentity || !record.runnerReadModel?.intervention.prompt.available)
      throw new Error(
        `Fixture ${name} lacks completed ACP continuation: ${JSON.stringify(record.runnerReadModel?.intervention.prompt)} metadata=${record.metadataPath}`
      );
    runs.push({ name, runId, runDir, controlDir, identity: promptIdentity });
  }
  await rebuildBlockRunIndex(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs"));
  const userData = join(directory, "user-data");
  await mkdir(userData);
  const launcher = join(directory, "launch-source-electron.cjs");
  const mainEntry = fileURLToPath(new URL("../../../dist/main/main.js", import.meta.url));
  await writeFile(
    launcher,
    [
      'const { app } = require("electron");',
      `app.setPath("userData", ${JSON.stringify(userData)});`,
      `process.env.PLANWEAVE_HOME = ${JSON.stringify(home)};`,
      `process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR = ${JSON.stringify(userData)};`,
      `process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = ${JSON.stringify(join(userData, "config", "desktop-settings.json"))};`,
      `import(${JSON.stringify(pathToFileURL(mainEntry).href)}).catch((error) => { console.error(error); app.exit(1); });`
    ].join("\n") + "\n"
  );
  const result = {
    directory,
    home,
    root,
    userData,
    launcher,
    projectId: init.workspace.id,
    canvasId: "default",
    taskId: "T-001",
    runs
  };
  await writeJsonFile(join(directory, "fixture.json"), result);
  return result;
}

export async function pauseTaskWorkspaceAcpFixture(controlDir: string) {
  await writeFile(join(controlDir, "lifecycle.log"), "");
  await writeFile(join(controlDir, "pause-at"), "session/prompt\n");
  await writeFile(join(controlDir, "pause"), "owned fixture barrier\n");
}

export async function releaseTaskWorkspaceAcpFixture(controlDir: string) {
  await unlink(join(controlDir, "pause"));
}

export async function waitForTaskWorkspaceAcpBarrier(controlDir: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (
        (await readFile(join(controlDir, "lifecycle.log"), "utf8")).includes(
          "paused session/prompt"
        )
      )
        return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`ACP fixture did not reach its prompt barrier: ${controlDir}`);
}

export async function readTaskWorkspaceAcpSmokeControls(path: string) {
  return z
    .object({ runs: z.array(z.object({ name: z.string(), controlDir: z.string() })) })
    .parse(JSON.parse(await readFile(path, "utf8")));
}
