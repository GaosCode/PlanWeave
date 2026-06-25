import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRunSessionEvent,
  createRunSession,
  getRunSession,
  listRunSessions,
  updateRunSession
} from "../runSessions/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("run session repository", () => {
  it("creates the first session in an empty canvas", async () => {
    const { root, init } = await createTestWorkspace();

    const session = await createRunSession({ projectRoot: root, kind: "run", now: new Date("2026-06-25T00:00:00.000Z") });

    expect(session).toMatchObject({
      sessionId: "SESSION-0001",
      kind: "run",
      trigger: "manual",
      canvasId: "default",
      scope: { kind: "project" },
      phase: "created",
      startedAt: "2026-06-25T00:00:00.000Z"
    });
    await expect(readFile(join(init.workspace.resultsDir, "run-sessions", "SESSION-0001", "session.json"), "utf8")).resolves.toContain(
      '"sessionId": "SESSION-0001"'
    );
  });

  it("allocates monotonic canvas-local ids after existing sessions", async () => {
    const { root } = await createTestWorkspace();

    await createRunSession({ projectRoot: root, kind: "run" });
    const second = await createRunSession({ projectRoot: root, kind: "reset" });

    expect(second.sessionId).toBe("SESSION-0002");
  });

  it("allocates unique ids for concurrent session creation", async () => {
    const { root } = await createTestWorkspace();

    const sessions = await Promise.all(Array.from({ length: 8 }, () => createRunSession({ projectRoot: root, kind: "run" })));

    expect(sessions.map((session) => session.sessionId).sort()).toEqual([
      "SESSION-0001",
      "SESSION-0002",
      "SESSION-0003",
      "SESSION-0004",
      "SESSION-0005",
      "SESSION-0006",
      "SESSION-0007",
      "SESSION-0008"
    ]);
    const listed = await listRunSessions(root);
    expect(listed.sessions).toHaveLength(8);
    expect(listed.diagnostics).toEqual([]);
  });

  it("writes append-only events and reads session detail", async () => {
    const { root } = await createTestWorkspace();
    const session = await createRunSession({ projectRoot: root, kind: "run" });

    await appendRunSessionEvent(root, session.sessionId, "step_finish", {
      phase: "running",
      stepKind: "submitted",
      claimRefs: ["T-001#B-001"],
      recordId: "T-001#B-001::RUN-001"
    });
    await updateRunSession(root, session.sessionId, { phase: "completed", finishedAt: "2026-06-25T00:01:00.000Z" });

    const detail = await getRunSession(root, session.sessionId);

    expect(detail.session).toMatchObject({ sessionId: "SESSION-0001", phase: "completed" });
    expect(detail.events.map((event) => event.type)).toEqual(["session_started", "step_finish"]);
    expect(detail.events[1]).toMatchObject({
      sessionId: "SESSION-0001",
      phase: "running",
      stepKind: "submitted",
      recordId: "T-001#B-001::RUN-001"
    });
    expect(detail.diagnostics).toEqual([]);
  });

  it("lists newest sessions first", async () => {
    const { root } = await createTestWorkspace();

    await createRunSession({ projectRoot: root, kind: "run", now: new Date("2026-06-25T00:00:00.000Z") });
    await createRunSession({ projectRoot: root, kind: "run", now: new Date("2026-06-25T00:02:00.000Z") });
    await createRunSession({ projectRoot: root, kind: "reset", now: new Date("2026-06-25T00:01:00.000Z") });

    const result = await listRunSessions(root);

    expect(result.sessions.map((session) => session.sessionId)).toEqual(["SESSION-0002", "SESSION-0003", "SESSION-0001"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("skips corrupt sessions with diagnostics when listing", async () => {
    const { root, init } = await createTestWorkspace();
    await createRunSession({ projectRoot: root, kind: "run" });
    const badRoot = join(init.workspace.resultsDir, "run-sessions", "SESSION-0002");
    await mkdir(badRoot, { recursive: true });
    await writeFile(join(badRoot, "session.json"), "{not json\n", "utf8");

    const result = await listRunSessions(root);

    expect(result.sessions.map((session) => session.sessionId)).toEqual(["SESSION-0001"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "run_session_read_failed",
        sessionId: "SESSION-0002",
        path: join(badRoot, "session.json")
      })
    ]);
  });

  it("skips structurally incomplete session summaries with diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    const badRoot = join(init.workspace.resultsDir, "run-sessions", "SESSION-0001");
    await mkdir(badRoot, { recursive: true });
    await writeFile(
      join(badRoot, "session.json"),
      JSON.stringify({
        sessionId: "SESSION-0001",
        phase: "created",
        startedAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z"
      }),
      "utf8"
    );

    const result = await listRunSessions(root);

    expect(result.sessions).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("kind")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("trigger")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("projectRoot")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("canvasId")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("scope")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("finishedAt")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("reset")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("autoRun")
      }),
      expect.objectContaining({
        code: "run_session_invalid",
        sessionId: "SESSION-0001",
        message: expect.stringContaining("nullable")
      })
    ]);
  });

  it("rejects invalid session ids before reading or writing paths", async () => {
    const { root } = await createTestWorkspace();

    await expect(getRunSession(root, "../SESSION-0001")).rejects.toThrow("Invalid run session id");
    await expect(appendRunSessionEvent(root, "../SESSION-0001", "step_finish")).rejects.toThrow("Invalid run session id");
    await expect(updateRunSession(root, "../SESSION-0001", { phase: "completed" })).rejects.toThrow("Invalid run session id");
  });
});
