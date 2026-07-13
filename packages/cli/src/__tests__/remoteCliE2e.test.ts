import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");
const tsxExecutable = resolve(repoRoot, "node_modules/.bin/tsx");
const cliEntry = resolve(repoRoot, "packages/cli/src/index.ts");

const TEST_SERVER_PORT = 19876;

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tsxExecutable, [cliEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env }
  });
}

async function runCliJson(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>> {
  const result = await runCli([...args, "--json"], env);
  return JSON.parse(result.stdout);
}

type CliFailure = Error & { code: number; stdout: string; stderr: string };

function isCliFailure(error: unknown): error is CliFailure {
  const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return error instanceof Error && typeof candidate.code === "number" && typeof candidate.stdout === "string" && typeof candidate.stderr === "string";
}

async function runCliExpectFailure(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliFailure> {
  try {
    await runCli(args, env);
  } catch (error) {
    if (isCliFailure(error)) throw error;
  }
  throw new Error(`Expected planweave ${args.join(" ")} to fail.`);
}

function makeServerHandler(): Server {
  const assignments = new Map<string, { id: string; version: number; taskId: string; branchName: string; baseCommit: string; leaseExpiresAt: string; status: string }>();
  const submissions: Array<{ submissionId: string; taskId: string; status: string; headCommit: string; baseCommit: string; createdAt: string }> = [];
  const revokedDevices = new Set<string>();

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${TEST_SERVER_PORT}`);
    const path = url.pathname;
    const headers = req.headers;

    function json(status: number, body: unknown) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    }

    function readBody(): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid JSON body"));
          }
        });
        req.on("error", reject);
      });
    }

    // Real team join handshake
    if (req.method === "POST" && path === "/api/v1/join") {
      readBody().then((body) => {
        if (body.joinToken !== "team-secret") {
          json(401, { error: { code: "unauthenticated", message: "Invalid join token", requestId: "", retryable: false } });
          return;
        }
        json(201, {
          session: { id: `session_${randomUUID()}`, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() },
          projectId: body.projectId,
          userId: `user_${randomUUID()}`,
          deviceId: `device_${randomUUID()}`,
          role: "contributor"
        });
      })
        .catch(() => json(422, { error: { code: "validation_failed", message: "Invalid body", requestId: "", retryable: false } }));
      return;
    }

    // Device revoke
    if (req.method === "POST" && path.startsWith("/api/v1/devices/") && path.endsWith("/revoke")) {
      const segments = path.split("/");
      const deviceId = segments[segments.length - 2]!;
      revokedDevices.add(deviceId);
      json(200, { device: { id: deviceId, status: "revoked" } });
      return;
    }

    // Session creation
    if (req.method === "POST" && path === "/api/v1/sessions") {
      readBody().then((body) => {
        const sessionId = `session_${randomUUID()}`;
        const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        json(200, { session: { id: sessionId, issuedAt: new Date().toISOString(), expiresAt } });
      }).catch(() => json(422, { error: { code: "validation_failed", message: "Invalid body", requestId: "", retryable: false } }));
      return;
    }

    // Check revoked device
    const authHeader = headers["authorization"] as string | undefined;
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/, "");
      if (token === "revoked-token") {
        json(401, { error: { code: "unauthenticated", message: "Device revoked", requestId: "", retryable: false } });
        return;
      }
    }

    // Claim task
    if (req.method === "POST" && path.match(/^\/api\/v1\/projects\/[^/]+\/tasks\/[^/]+\/claim$/)) {
      readBody().then((body) => {
        const taskId = typeof body.taskId === "string" ? body.taskId : "unknown";
        const branchName = typeof body.branchName === "string" ? body.branchName : "unknown";
        const baseCommit = typeof body.baseCommit === "string" ? body.baseCommit : "HEAD";
        const assignmentId = `asn_${randomUUID().slice(0, 12)}`;

        // If task already has active assignment, return conflict
        for (const [, assignment] of assignments) {
          if (assignment.taskId === taskId && assignment.status === "active") {
            json(409, { error: { code: "state_conflict", message: "Task already has an active assignment.", requestId: "", retryable: false, details: { policyConflict: { activeAssignmentId: assignment.id, reason: "task_locked" } } } });
            return;
          }
        }

        const leaseExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
        const assignment = {
          id: assignmentId,
          version: 1,
          taskId,
          branchName,
          baseCommit,
          leaseExpiresAt,
          status: "active"
        };
        assignments.set(assignmentId, assignment);

        json(200, {
          assignment,
          task: { id: `t_${taskId}`, taskId, title: `Task ${taskId}`, version: 1, status: "leased" },
          replayed: false
        });
      }).catch(() => json(422, { error: { code: "validation_failed", message: "Invalid body", requestId: "", retryable: false } }));
      return;
    }

    // Heartbeat
    if (req.method === "POST" && path.match(/^\/api\/v1\/projects\/[^/]+\/assignments\/[^/]+\/heartbeat$/)) {
      const assignmentId = path.split("/")[6]!;
      const assignment = assignments.get(assignmentId);
      if (!assignment) {
        json(404, { error: { code: "not_found", message: "Assignment not found", requestId: "", retryable: false } });
        return;
      }
      readBody().then(() => {
        assignment.version += 1;
        assignment.leaseExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
        json(200, { assignment, newLeaseExpiresAt: assignment.leaseExpiresAt, replayed: false });
      }).catch(() => json(422, { error: { code: "validation_failed", message: "Invalid body", requestId: "", retryable: false } }));
      return;
    }

    // Submit
    if (req.method === "POST" && path.match(/^\/api\/v1\/projects\/[^/]+\/assignments\/[^/]+\/submit$/)) {
      const assignmentId = path.split("/")[6]!;
      const assignment = assignments.get(assignmentId);
      if (!assignment) {
        json(404, { error: { code: "not_found", message: "Assignment not found", requestId: "", retryable: false } });
        return;
      }
      readBody().then((body) => {
        const submissionId = `sub_${randomUUID().slice(0, 12)}`;
        const sub = {
          submissionId,
          taskId: assignment.taskId,
          status: "open",
          headCommit: typeof body.headCommit === "string" ? body.headCommit : "HEAD",
          baseCommit: typeof body.baseCommit === "string" ? body.baseCommit : assignment.baseCommit,
          createdAt: new Date().toISOString()
        };
        submissions.push(sub);
        assignment.status = "submitted";
        json(200, {
          submission: { id: submissionId, version: 1, headCommit: sub.headCommit, status: "open" },
          assignment,
          replayed: false
        });
      }).catch(() => json(422, { error: { code: "validation_failed", message: "Invalid body", requestId: "", retryable: false } }));
      return;
    }

    // Events
    if (req.method === "GET" && path.match(/^\/api\/v1\/projects\/[^/]+\/events$/)) {
      json(200, { items: [], nextCursor: null });
      return;
    }

    // Snapshot
    if (req.method === "GET" && path.match(/^\/api\/v1\/projects\/[^/]+\/snapshot$/)) {
      json(200, { project: { id: "test-project", version: 1, name: "Test Project" }, lastEventId: "42" });
      return;
    }

    // Merge queue
    if (req.method === "GET" && path.match(/^\/api\/v1\/projects\/[^/]+\/merge-queue$/)) {
      json(200, { submissions });
      return;
    }

    // Health
    if (path === "/healthz") {
      json(200, { status: "ready" });
      return;
    }

    json(404, { error: { code: "not_found", message: "Not found", requestId: "", retryable: false } });
  });
}

describe("remote CLI E2E", () => {
  let server: Server;
  let serverUrl: string;
  let profileDir: string;

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), "planweave-e2e-"));
    const homeDir = join(profileDir, "home");
    await mkdir(join(homeDir, ".planweave", "config"), { recursive: true });
    await mkdir(join(homeDir, ".planweave", "config", "credentials"), { recursive: true });

    server = makeServerHandler();
    await new Promise<void>((resolve) => server.listen(TEST_SERVER_PORT, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${TEST_SERVER_PORT}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profileDir, { recursive: true, force: true });
  });

  function env(): NodeJS.ProcessEnv {
    return {
      HOME: join(profileDir, "home"),
      XDG_CONFIG_HOME: join(profileDir, "home", ".config"),
      PLANWEAVE_HOME: join(profileDir, "home", ".planweave")
    };
  }

  it("joins as two users, claims a task, creates a branch, submits work, revokes credentials", { timeout: 60_000 }, async () => {
    const e = env();

    // User A joins
    const joinA = await runCliJson(["server", "join", "--url", serverUrl, "--name", "alice-lab", "--project", "proj-1", "--user", "user-alice", "--token", "team-secret"], e);
    expect(joinA.kind).toBe("joined");

    // User B joins
    const joinB = await runCliJson(["server", "join", "--url", serverUrl, "--name", "bob-office", "--project", "proj-1", "--user", "user-bob", "--token", "team-secret"], e);
    expect(joinB.kind).toBe("joined");

    // List profiles
    const list = await runCliJson(["server", "list"], e);
    expect(list.profiles).toBeDefined();
    expect(Array.isArray(list.profiles)).toBe(true);
    expect((list.profiles as Array<Record<string, unknown>>).length).toBe(2);

    // Alice sets project
    const projectSet = await runCliJson(["server", "project", "--profile", "alice-lab", "--id", "proj-2"], e);
    expect(projectSet.kind).toBe("updated");

    // Alice claims a task
    const claim = await runCliJson(["task", "claim", "--profile", "alice-lab", "--task-id", "task-implement-login", "--branch", "pw/login-work", "--base-commit", "abc1234"], e);
    expect(claim.kind).toBe("claimed");
    expect((claim.assignment as Record<string, unknown>).status).toBe("active");

    // Alice checkouts (gets branch name)
    const checkout = await runCliJson(["task", "checkout", "--profile", "alice-lab"], e);
    expect(checkout.kind).toBe("checkout");
    expect((checkout as Record<string, unknown>).branchName).toBeDefined();

    // Alice sends heartbeat
    const heartbeat = await runCliJson(["task", "heartbeat", "--profile", "alice-lab"], e);
    expect(heartbeat.kind).toBe("heartbeated");

    // Alice submits work
    const submit = await runCliJson(["task", "submit", "--profile", "alice-lab", "--head-commit", "def5678"], e);
    expect(submit.kind).toBe("submitted");

    // Merge queue status
    const mergeQueue = await runCliJson(["merge-queue", "--profile", "alice-lab"], e);
    expect(mergeQueue.kind).toBe("merge_queue");

    // Alice forgets her profile
    const forget = await runCliJson(["server", "forget", "--name", "alice-lab"], e);
    expect(forget.kind).toBe("removed");

    // Bob forgets his profile
    const forgetB = await runCliJson(["server", "forget", "--name", "bob-office"], e);
    expect(forgetB.kind).toBe("removed");
  });

  it("throws proper error for missing profile", { timeout: 15_000 }, async () => {
    const result = await runCliJson(["task", "claim", "--profile", "nonexistent", "--task-id", "t1", "--branch", "b", "--base-commit", "abc"], env());
    expect(result.kind).toBe("blocked");
    expect(result.reason).toBe("Profile 'nonexistent' not found.");
  });

  it("duplicate join is rejected", { timeout: 30_000 }, async () => {
    const e = env();
    await runCli(["server", "join", "--url", serverUrl, "--name", "dup-test", "--project", "p", "--user", "u", "--token", "team-secret"], e);
    const result = await runCliJson(["server", "join", "--url", serverUrl, "--name", "dup-test", "--project", "p", "--user", "u", "--token", "team-secret"], e);
    expect(result.kind).toBe("blocked");
    expect(result.reason).toBe("Profile 'dup-test' already exists.");
    await runCli(["server", "forget", "--name", "dup-test"], e);
  });

  it("reconnects (re-joins) after forgetting", { timeout: 30_000 }, async () => {
    const e = env();
    // Join
    const join1 = await runCliJson(["server", "join", "--url", serverUrl, "--name", "reconnect-test", "--project", "p", "--user", "u", "--token", "team-secret"], e);
    expect(join1.kind).toBe("joined");
    // Forget
    await runCli(["server", "forget", "--name", "reconnect-test"], e);
    // Re-join
    const join2 = await runCliJson(["server", "join", "--url", serverUrl, "--name", "reconnect-test", "--project", "p", "--user", "u", "--token", "team-secret"], e);
    expect(join2.kind).toBe("joined");
    // Cleanup
    await runCli(["server", "forget", "--name", "reconnect-test"], e);
  });
});
