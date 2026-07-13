import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
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

    async function joinUser(displayName: string, deviceName: string) {
      const response = await fetch(`${base}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-team", projectName: "Team Project", displayName, deviceName, joinToken: "team-secret" }) });
      expect(response.status).toBe(201);
      return (await response.json() as { session: { id: string }; userId: string; deviceId: string; role: string });
    }

    const alice = await joinUser("alice", "device-alice");
    const bob = await joinUser("bob", "device-bob");
    expect(alice.role).toBe("owner");
    expect(bob.role).toBe("contributor");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/events?projectId=project-team&afterEventId=0`, {
      headers: { authorization: `Bearer ${alice.session.id}`, "x-planweave-project-id": "project-team" }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const nextEvent = new Promise<{ event: { type: string; eventId: string } }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for collaboration event")), 3_000);
      const onMessage = (data: RawData) => {
        const message = JSON.parse(data.toString()) as { event: { type: string; eventId: string } };
        if (message.event.type !== "task.claimed") return;
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(message);
      };
      socket.on("message", onMessage);
    });

    const createdTask = await fetch(`${base}/api/v1/projects/project-team/tasks`, { method: "POST", headers: { authorization: `Bearer ${alice.session.id}`, "content-type": "application/json" }, body: JSON.stringify({ taskId: "frontend", title: "Connect Team UI", ownershipScopes: ["packages/desktop/**"], acceptanceChecks: ["pnpm --dir packages/desktop build"], reviewers: ["alice"] }) });
    expect(createdTask.status).toBe(201);
    expect(await createdTask.json()).toMatchObject({ taskId: "frontend", policy: { ownershipScopes: ["packages/desktop/**"] } });

    const claimed = await fetch(`${base}/api/v1/projects/project-team/tasks/frontend/claim`, { method: "POST", headers: { authorization: `Bearer ${bob.session.id}`, "content-type": "application/json", "idempotency-key": "claim-bob-00000001" }, body: JSON.stringify({ branchName: "team/bob/frontend", baseCommit: "HEAD", leaseDurationSeconds: 3600 }) });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ assignment: { assigneeUserId: bob.userId, status: "active" } });
    await expect(nextEvent).resolves.toMatchObject({ event: { type: "task.claimed", eventId: expect.any(String) } });
    socket.close();
    const tasks = await fetch(`${base}/api/v1/projects/project-team/tasks`, { headers: { authorization: `Bearer ${alice.session.id}` } });
    expect(await tasks.json()).toEqual([expect.objectContaining({ taskId: "frontend", status: "leased" })]);

    const auth = { authorization: `Bearer ${bob.session.id}` };
    const members = await fetch(`${base}/api/v1/projects/project-team/members`, { headers: auth });
    expect(await members.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: alice.userId, online: true }),
      expect.objectContaining({ userId: bob.userId, online: true })
    ]));

    const rooms = await fetch(`${base}/api/v1/projects/project-team/rooms`, { headers: auth });
    const roomList = await rooms.json() as Array<{ id: string }>;
    expect(roomList).toHaveLength(1);
    const sent = await fetch(`${base}/api/v1/projects/project-team/rooms/${roomList[0]!.id}/messages`, { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": "message-key-00000001" }, body: JSON.stringify({ body: "Hello from Bob" }) });
    expect(sent.status).toBe(201);
    const messages = await fetch(`${base}/api/v1/projects/project-team/rooms/${roomList[0]!.id}/messages`, { headers: auth });
    expect(await messages.json()).toEqual([expect.objectContaining({ authorUserId: bob.userId, body: "Hello from Bob" })]);

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

  it("never accepts a client-selected existing identity", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-collab-identity-"));
    const app = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "server.sqlite"), host: "127.0.0.1", port: 0, busyTimeoutMs: 5000, joinToken: "right-token" });
    const http = app.createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => http.close(() => resolve())); app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;
    const first = await fetch(`${base}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "p", displayName: "owner", deviceName: "owner-device", joinToken: "right-token" }) });
    const owner = await first.json() as { userId: string; deviceId: string };
    const second = await fetch(`${base}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "p", userId: owner.userId, deviceId: owner.deviceId, displayName: "attacker", deviceName: "attacker-device", joinToken: "right-token" }) });
    const attacker = await second.json() as { userId: string; deviceId: string; role: string };
    expect(attacker.userId).not.toBe(owner.userId);
    expect(attacker.deviceId).not.toBe(owner.deviceId);
    expect(attacker.role).toBe("contributor");
  });

  it("persists an evidence-backed board and freezes it only after every contributor approves", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-consensus-"));
    const app = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "server.sqlite"), host: "127.0.0.1", port: 0, busyTimeoutMs: 5000, joinToken: "consensus-secret" });
    const http = app.createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => http.close(() => resolve())); app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;

    async function joinUser(displayName: string) {
      const response = await fetch(`${base}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-consensus", projectName: "Consensus Project", displayName, deviceName: `${displayName}-device`, joinToken: "consensus-secret" }) });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ session: { id: string }; resumeToken: string; userId: string; deviceId: string }>;
    }
    const owner = await joinUser("owner");
    const member = await joinUser("member");
    const ownerHeaders = { authorization: `Bearer ${owner.session.id}`, "content-type": "application/json" };
    const memberHeaders = { authorization: `Bearer ${member.session.id}`, "content-type": "application/json" };

    const attachment = await fetch(`${base}/api/v1/projects/project-consensus/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${member.session.id}`, "content-type": "text/plain", "x-planweave-file-name": encodeURIComponent("requirements.txt"), "idempotency-key": "attachment-consensus-0001" },
      body: "offline-first and durable"
    });
    expect(attachment.status).toBe(201);
    const attachmentBody = await attachment.json() as { id: string; status: string };
    expect(attachmentBody.status).toBe("ready");

    const created = await fetch(`${base}/api/v1/projects/project-consensus/baselines`, {
      method: "POST",
      headers: { ...ownerHeaders, "idempotency-key": "baseline-consensus-0001" },
      body: JSON.stringify({ title: "LAN collaboration v1", summary: "Frozen shared intent", requirements: ["All clients see the same board"], constraints: ["LAN-only"], decisions: ["Host is authoritative"], acceptanceCriteria: ["All checks pass"], risks: ["Host outage"], openQuestions: [], citations: [{ kind: "attachment", id: attachmentBody.id }] })
    });
    expect(created.status).toBe(201);
    const baseline = await created.json() as { id: string; revision: number };

    const ownerApproval = await fetch(`${base}/api/v1/projects/project-consensus/baselines/${baseline.id}/decision`, { method: "POST", headers: { ...ownerHeaders, "idempotency-key": "approve-owner-0000001" }, body: JSON.stringify({ decision: "approve" }) });
    expect(ownerApproval.status).toBe(200);
    const earlyFreeze = await fetch(`${base}/api/v1/projects/project-consensus/baselines/${baseline.id}/freeze`, { method: "POST", headers: { ...ownerHeaders, "idempotency-key": "freeze-early-00000001" }, body: "{}" });
    expect(earlyFreeze.status).toBe(409);

    const memberApproval = await fetch(`${base}/api/v1/projects/project-consensus/baselines/${baseline.id}/decision`, { method: "POST", headers: { ...memberHeaders, "idempotency-key": "approve-member-00001" }, body: JSON.stringify({ decision: "approve" }) });
    expect(memberApproval.status).toBe(200);
    const frozen = await fetch(`${base}/api/v1/projects/project-consensus/baselines/${baseline.id}/freeze`, { method: "POST", headers: { ...ownerHeaders, "idempotency-key": "freeze-final-00000001" }, body: "{}" });
    expect(frozen.status).toBe(200);
    expect(await frozen.json()).toMatchObject({ id: baseline.id, status: "frozen" });

    const task = await fetch(`${base}/api/v1/projects/project-consensus/tasks`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ taskId: "durability", title: "Implement durable sync", description: "Persist event cursor", baselineId: baseline.id, requirementIds: ["R1"], ownershipScopes: ["packages/server/**"], acceptanceChecks: ["pnpm lint"], reviewers: [owner.userId] }) });
    expect(task.status).toBe(201);
    expect(await task.json()).toMatchObject({ baselineId: baseline.id, requirementIds: ["R1"] });

    const preference = await fetch(`${base}/api/v1/projects/project-consensus/tasks/durability/preference`, { method: "POST", headers: { ...memberHeaders, "idempotency-key": "preference-member-0001" }, body: JSON.stringify({ note: "I own the server package" }) });
    expect(preference.status).toBe(200);
    const agent = await fetch(`${base}/api/v1/projects/project-consensus/agent-profile`, { method: "POST", headers: { ...memberHeaders, "idempotency-key": "agent-member-00000001" }, body: JSON.stringify({ kind: "codex", name: "Codex", capabilities: ["review", "test"] }) });
    expect(agent.status).toBe(200);

    const coordination = await fetch(`${base}/api/v1/projects/project-consensus/coordination`, { headers: { authorization: `Bearer ${owner.session.id}` } });
    expect(await coordination.json()).toMatchObject({ phase: "execution", activeBaselineId: baseline.id, baselines: [expect.objectContaining({ id: baseline.id, citations: [{ kind: "attachment", id: attachmentBody.id }] })], preferences: [expect.objectContaining({ taskId: "durability", userId: member.userId })], agentProfiles: [expect.objectContaining({ userId: member.userId, kind: "codex" })] });

    app.database.prepare("UPDATE sessions SET expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", member.session.id);
    const resumed = await fetch(`${base}/api/v1/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project-consensus", deviceId: member.deviceId, resumeToken: member.resumeToken }) });
    expect(resumed.status).toBe(201);
    expect(await resumed.json()).toMatchObject({ userId: member.userId, deviceId: member.deviceId, session: { id: expect.any(String) } });
  });
});
