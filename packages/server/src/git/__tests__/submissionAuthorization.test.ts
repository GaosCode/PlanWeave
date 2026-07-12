import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer } from "../../lifecycle.js";
import { createMergeQueueServices } from "../mergeQueue.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("merge queue submission authorization with production schema", () => {
  it("rejects a fabricated submission even for a project member", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-mq-auth-"));
    directories.push(dataDirectory);
    const server = await startPlanweaveServer({
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      host: "127.0.0.1",
      port: 0,
      busyTimeoutMs: 5000
    });
    try {
      server.database.prepare("INSERT INTO projects(id,name,created_at) VALUES (?,?,?)").run("project-auth", "Auth", new Date().toISOString());
      server.database.prepare("INSERT INTO memberships(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run("project-auth", "user-member", "contributor", new Date().toISOString());
      const services = createMergeQueueServices({ database: server.database, config: { dataDirectory, requireApproval: false } });

      expect(() => services.enqueueSubmission({
        deviceId: "device-member",
        idempotencyKey: "fabricated-submission-1",
        projectId: "project-auth",
        submissionId: "sub-does-not-exist",
        headCommit: "head-fabricated",
        baseCommit: "base-fabricated",
        targetBranch: "main",
        actorId: "user-member"
      })).toThrowError(/does not belong/);
    } finally {
      server.close();
    }
  });
});
