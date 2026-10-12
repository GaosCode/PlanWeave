import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as locks from "../fs/advisoryDirectoryLock.js";
import * as json from "../json.js";
import * as pruneIdentity from "../runSessions/pruneArtifactIdentity.js";
import { computePrunePlan, getRunSession, runWithSession } from "../runSessions/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const directories: string[] = [];
let previousHome: string | undefined;
let previousSettings: string | undefined;
beforeEach(() => {
  previousHome = process.env.PLANWEAVE_HOME;
  previousSettings = process.env.PLANWEAVE_SETTINGS_FILE;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = previousHome;
  if (previousSettings === undefined) delete process.env.PLANWEAVE_SETTINGS_FILE;
  else process.env.PLANWEAVE_SETTINGS_FILE = previousSettings;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("terminal session retention admission", () => {
  it.each([
    "completed",
    "stopped",
    "failed"
  ] as const)("publishes %s summary and final event before a queued prune observes the session", async (phase) => {
    const { root, home, init } = await createTestWorkspace();
    directories.push(root, home);
    const written = gate();
    const release = gate();
    const pruneQueued = gate();
    const summaryPath = join(
      init.workspace.resultsDir,
      "run-sessions",
      "SESSION-0001",
      "session.json"
    );
    const eventsPath = join(
      init.workspace.resultsDir,
      "run-sessions",
      "SESSION-0001",
      "events.ndjson"
    );
    const write = json.writeJsonFile;
    const lock = locks.withAdvisoryDirectoryLock;
    let waitingForPrune = false;
    vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value, options) => {
      await write(path, value, options);
      if (
        path === summaryPath &&
        value &&
        typeof value === "object" &&
        "phase" in value &&
        value.phase === phase
      ) {
        waitingForPrune = true;
        written.resolve();
        await release.promise;
      }
    });
    vi.spyOn(locks, "withAdvisoryDirectoryLock").mockImplementation((options, action) => {
      const pending = lock(options, action);
      if (waitingForPrune && options.operation === "project-mutation") pruneQueued.resolve();
      return pending;
    });
    const captureIdentity = pruneIdentity.pruneArtifactIdentity;
    let observedEvents: string | undefined;
    vi.spyOn(pruneIdentity, "pruneArtifactIdentity").mockImplementation(async (path, session) => {
      const identity = await captureIdentity(path, session);
      if (session && join(path, "session.json") === summaryPath) {
        observedEvents = await readFile(eventsPath, "utf8");
      }
      return identity;
    });
    const update = await import("../runSessions/repository.js");
    const updateSession = update.updateRunSession;
    if (phase === "failed") {
      vi.spyOn(update, "updateRunSession").mockImplementation((owner, id, patch, options) => {
        if (patch.phase === "running") throw new Error("executor setup failed");
        return updateSession(owner, id, patch, options);
      });
    }
    const abort = new AbortController();
    if (phase === "stopped") abort.abort();
    const execution = runWithSession({
      projectRoot: root,
      stepLimit: 0,
      tmuxEnabled: false,
      signal: abort.signal
    });
    let observed: Promise<Awaited<ReturnType<typeof computePrunePlan>>> | undefined;
    try {
      await written.promise;
      observed = computePrunePlan(init.workspace, { keepLast: 0 });
      await pruneQueued.promise;
      release.resolve();
      const snapshot = await observed;
      expect(snapshot.items.map((item) => item.id)).toContain("SESSION-0001");
      expect(observedEvents).toContain(`"type":"session_${phase}"`);
      const result = await execution;
      expect(result.session.phase).toBe(phase);
      expect((await getRunSession(init.workspace, "SESSION-0001")).events.at(-1)?.type).toBe(
        `session_${phase}`
      );
    } finally {
      release.resolve();
      await Promise.allSettled([execution, ...(observed ? [observed] : [])]);
    }
  });
});
