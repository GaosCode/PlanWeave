import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer } from "../lifecycle.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("real multi-user collaboration HTTP API", () => {
  it("joins two users and shares members, rooms, messages, and snapshots", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-collab-"));
    const app = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "server.sqlite"), host: "127.0.0.1", port: 0, busyTimeoutMs: 5000, joinToken: "team-secret" });
    const http = app.createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => http.close(() => resolve())); app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;

    async function joinUser(userId: string, deviceId: string) {
      const response = await fetch(`${base}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-team", projectName: "Team Project", userId, displayName: userId, deviceId, joinToken: "team-secret" }) });
      expect(response.status).toBe(201);
      return (await response.json() as { session: { id: string }; role: string });
    }

    const alice = await joinUser("alice", "device-alice");
    const bob = await joinUser("bob", "device-bob");
    expect(alice.role).toBe("owner");
    expect(bob.role).toBe("contributor");

    const createdTask = await fetch(`${base}/api/v1/projects/project-team/tasks`, { method: "POST", headers: { authorization: `Bearer ${alice.session.id}`, "content-type": "application/json" }, body: JSON.stringify({ taskId: "frontend", title: "Connect Team UI", ownershipScopes: ["packages/desktop/**"], acceptanceChecks: ["pnpm --dir packages/desktop build"], reviewers: ["alice"] }) });
    expect(createdTask.status).toBe(201);
    expect(await createdTask.json()).toMatchObject({ taskId: "frontend", policy: { ownershipScopes: ["packages/desktop/**"] } });

    const claimed = await fetch(`${base}/api/v1/projects/project-team/tasks/frontend/claim`, { method: "POST", headers: { authorization: `Bearer ${bob.session.id}`, "content-type": "application/json", "idempotency-key": "claim-bob-00000001" }, body: JSON.stringify({ branchName: "team/bob/frontend", baseCommit: "HEAD", leaseDurationSeconds: 3600 }) });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ assignment: { assigneeUserId: "bob", status: "active" } });
    const tasks = await fetch(`${base}/api/v1/projects/project-team/tasks`, { headers: { authorization: `Bearer ${alice.session.id}` } });
    expect(await tasks.json()).toEqual([expect.objectContaining({ taskId: "frontend", status: "leased" })]);

    const auth = { authorization: `Bearer ${bob.session.id}` };
    const members = await fetch(`${base}/api/v1/projects/project-team/members`, { headers: auth });
    expect(await members.json()).toEqual(expect.arrayContaining([expect.objectContaining({ userId: "alice" }), expect.objectContaining({ userId: "bob" })]));

    const rooms = await fetch(`${base}/api/v1/projects/project-team/rooms`, { headers: auth });
    const roomList = await rooms.json() as Array<{ id: string }>;
    expect(roomList).toHaveLength(1);
    const sent = await fetch(`${base}/api/v1/projects/project-team/rooms/${roomList[0]!.id}/messages`, { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": "message-key-00000001" }, body: JSON.stringify({ body: "Hello from Bob" }) });
    expect(sent.status).toBe(201);
    const messages = await fetch(`${base}/api/v1/projects/project-team/rooms/${roomList[0]!.id}/messages`, { headers: auth });
    expect(await messages.json()).toEqual([expect.objectContaining({ authorUserId: "bob", body: "Hello from Bob" })]);

    const snapshot = await fetch(`${base}/api/v1/projects/project-team/snapshot`, { headers: { authorization: `Bearer ${alice.session.id}` } });
    expect(await snapshot.json()).toMatchObject({ project: { id: "project-team", name: "Team Project" } });
  });

  it("rejects a wrong join token and unauthenticated project access", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-collab-auth-"));
    const app = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "server.sqlite"), host: "127.0.0.1", port: 0, busyTimeoutMs: 5000, joinToken: "right-token" });
    const http = app.createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => http.close(() => resolve())); app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "p", userId: "u", deviceId: "d", joinToken: "wrong" }) })).status).toBe(401);
    expect((await fetch(`${base}/api/v1/projects/p/snapshot`)).status).toBe(401);
  });
});
