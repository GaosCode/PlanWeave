import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACP_CONVERSATION_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  ACP_CONVERSATION_CAPABILITY,
  ACP_TASK_RESTORE_CAPABILITY,
  acpConversationPageSchema,
  acpConversationOrderedPaginatedPageSchema
} from "@planweave-ai/agent-host-protocol";
import { createConversationCompatibilityFixture } from "./support/acpConversationCompatibilityFixture.js";
import { AcpConversationRetention } from "../acpConversationRetention.js";
import { legacyAcpConversationPageSchema } from "./support/legacyAcpConversationContract.js";

const fixtures: Awaited<ReturnType<typeof createConversationCompatibilityFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup(
  legacy = false,
  options?: Parameters<typeof createConversationCompatibilityFixture>[1]
) {
  const f = await createConversationCompatibilityFixture(legacy, options);
  fixtures.push(f);
  return f;
}

describe("ACP conversation independent upgrades", () => {
  it.each([
    ["owner", 1],
    ["owner", 2],
    ["workspace", 1],
    ["workspace", 2]
  ] as const)("keeps %s restore side effects single-flight with v%i arriving first", async (surface, firstVersion) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let restores = 0;
    const f = await setup(false, {
      restoreTask: async (operation) => {
        restores++;
        entered();
        await gate;
        return { operation };
      }
    });
    f.hosts.reportOnline(
      f.host.id,
      ["acp.codex", ACP_CONVERSATION_CAPABILITY, ACP_TASK_RESTORE_CAPABILITY],
      2
    );
    f.db.prepare("UPDATE remote_operations SET state='cancelled' WHERE id=?").run(f.operation.id);
    const body = JSON.stringify({
      kind: "restore_task",
      turnId: "restore",
      executionAttemptId: f.prompt.executionAttemptId,
      sessionId: f.prompt.sessionId
    });
    const request = (version: number) =>
      fetch(f.path(surface, version), { method: "POST", headers: f.headers(surface), body });
    const first = request(firstVersion);
    await started;
    const authorizations = f.authorize.mock.calls.length;
    const second = request(firstVersion === 1 ? 2 : 1);
    await vi.waitFor(() => expect(f.authorize.mock.calls.length).toBeGreaterThan(authorizations));
    release();
    const responses = await Promise.all([first, second]);
    const pages = [];
    for (let index = 0; index < responses.length; index++) {
      expect(responses[index]!.status).toBe(202);
      const page = await responses[index]!.json();
      const version = index === 0 ? firstVersion : firstVersion === 1 ? 2 : 1;
      pages.push(
        version === 1
          ? legacyAcpConversationPageSchema.parse(page)
          : acpConversationPageSchema.parse(page)
      );
      expect("turnCursor" in page).toBe(version === 2);
    }
    expect(pages[0]!.restoredOperationId).toBe(pages[1]!.restoredOperationId);
    expect(restores).toBe(1);
  });
  it.each([
    ["owner", 1],
    ["owner", 2],
    ["workspace", 1],
    ["workspace", 2]
  ] as const)("keeps strict %s v%i empty/small GET and POST readable", async (surface, version) => {
    const f = await setup();
    const parse = (input: unknown) =>
      version === 1
        ? legacyAcpConversationPageSchema.parse(input)
        : acpConversationPageSchema.parse(input);
    const get = await fetch(f.path(surface, version), { headers: f.headers(surface) });
    expect(get.status).toBe(200);
    expect(parse(await get.json()).turns).toEqual([]);
    const post = await fetch(f.path(surface, version), {
      method: "POST",
      headers: f.headers(surface),
      body: JSON.stringify(f.prompt)
    });
    expect(post.status).toBe(202);
    expect(parse(await post.json()).turns).toMatchObject([{ turnId: f.prompt.turnId }]);
    const read = await fetch(f.path(surface, version), { headers: f.headers(surface) });
    expect(parse(await read.json()).turns).toHaveLength(1);
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("rejects unrepresentable legacy %s GET/POST before durably accepting commands", async (surface) => {
    const f = await setup();
    for (let i = 0; i < 12; i++) {
      const turnId = `large-${i}`;
      f.service.act(f.operation, "compat-actor", { ...f.prompt, turnId });
      f.service.ingest(
        f.host.id,
        f.event(1, { kind: "status", status: "failed", error: "\u0001".repeat(64 * 1024) }, turnId)
      );
    }
    const before = f.mailbox.listAfter(f.host.id, 0);
    for (const method of ["GET", "POST"] as const) {
      const response = await fetch(f.path(surface), {
        method,
        headers: f.headers(surface),
        ...(method === "POST"
          ? { body: JSON.stringify({ ...f.prompt, turnId: "must-not-queue" }) }
          : {})
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "acp_conversation_client_upgrade_required"
      });
    }
    expect(f.mailbox.listAfter(f.host.id, 0)).toEqual(before);
    expect(
      f.db
        .prepare("SELECT turn_id FROM acp_conversation_turns WHERE turn_id='must-not-queue'")
        .get()
    ).toBeUndefined();
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("reports old-server upgrade for %s GET/POST without mutations, and preserves business 404", async (surface) => {
    const old = await setup(true);
    const before = old.mailbox.listAfter(old.host.id, 0);
    for (const action of [undefined, old.prompt]) {
      const call =
        surface === "owner"
          ? old.owner.acpConversation(old.operation.id, 0, "compat-actor", action, "cursor-from-v2")
          : old.workspace.acpConversation(old.operation.id, 0, action, "cursor-from-v2");
      await expect(call).rejects.toMatchObject({
        code: "acp_conversation_server_upgrade_required"
      });
    }
    expect(old.mailbox.listAfter(old.host.id, 0)).toEqual(before);
    const current = await setup();
    const call =
      surface === "owner"
        ? current.owner.acpConversation("missing-operation", 0, "compat-actor")
        : current.workspace.acpConversation("missing-operation", 0);
    await expect(call).rejects.toMatchObject({
      httpStatus: 404,
      code: surface === "owner" ? "operator_resource_not_found" : "human_remote_resource_not_found"
    });
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("drains v3 %s metadata and events exactly and observes terminal updates/compaction", async (surface) => {
    const f = await setup();
    const ids = Array.from(
      { length: 22 },
      (_, i) => `${i === 0 ? "z-first" : i === 1 ? "a-second" : `turn-${i}`}`
    );
    for (const turnId of ids) {
      f.service.act(f.operation, "compat-actor", { ...f.prompt, turnId });
      f.service.ingest(
        f.host.id,
        f.event(1, { kind: "status", status: "failed", error: "\u0001".repeat(64 * 1024) }, turnId)
      );
    }
    const active = { ...f.prompt, turnId: "active" };
    const call = (cursor: number, afterTurnId: string | null, action?: typeof active) =>
      surface === "owner"
        ? f.owner.acpConversation(f.operation.id, cursor, "compat-actor", action, afterTurnId)
        : f.workspace.acpConversation(f.operation.id, cursor, action, afterTurnId);
    let page = await call(0, null, active);
    const turns = new Map(page.turns.map((turn) => [turn.turnId, turn]));
    const events = [...page.events];
    let count = 1;
    expect(page.hasMoreTurns).toBe(true);
    expect(page.turns[0]?.turnId).toBe(active.turnId);
    expect(page.turns[0]?.turnOrder).toBeGreaterThan(page.turns[1]!.turnOrder);
    while (page.hasMore) {
      const before = [page.cursor, page.turnCursor];
      page = await call(page.cursor, page.turnCursor);
      expect([page.cursor, page.turnCursor]).not.toEqual(before);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        ACP_CONVERSATION_RESPONSE_MAX_BYTES
      );
      for (const turn of page.turns) turns.set(turn.turnId, turn);
      events.push(...page.events);
      expect(++count).toBeLessThan(20);
    }
    expect(
      [...turns.values()].sort((a, b) => a.turnOrder - b.turnOrder).map((turn) => turn.turnId)
    ).toEqual([...ids, active.turnId]);
    expect(new Set([...turns.values()].map((turn) => turn.turnOrder)).size).toBe(turns.size);
    expect(events.map((event) => event.messageId)).toEqual(ids.map((id) => `message-${id}-1`));
    f.service.ingest(
      f.host.id,
      f.event(1, { kind: "status", status: "completed", error: null }, active.turnId)
    );
    f.db
      .prepare("UPDATE acp_conversation_turns SET compacted_at=? WHERE turn_id=?")
      .run(f.clock().toISOString(), ids[0]);
    let delta = await call(page.cursor, null);
    expect(delta.retention?.compactedTurnIds).toEqual([ids[0]]);
    const refreshed = new Map(delta.turns.map((turn) => [turn.turnId, turn]));
    const updates = [...delta.events];
    while (delta.hasMore) {
      delta = await call(delta.cursor, delta.turnCursor);
      for (const turn of delta.turns) refreshed.set(turn.turnId, turn);
      updates.push(...delta.events);
    }
    expect(refreshed.get(active.turnId)?.status).toBe("completed");
    expect(updates.map((event) => event.messageId)).toEqual([`message-${active.turnId}-1`]);
    const before = [...refreshed.values()].sort((a, b) => a.turnOrder - b.turnOrder);
    const compacted = new AcpConversationRetention(
      f.db,
      () => new Date(f.clock().getTime() + 31 * 24 * 60 * 60 * 1_000)
    ).compactBatch();
    expect(compacted.compacted).toBeGreaterThan(0);
    let restored = await call(0, null);
    const restoredTurns = new Map(restored.turns.map((turn) => [turn.turnId, turn]));
    while (restored.hasMore) {
      restored = await call(restored.cursor, restored.turnCursor);
      for (const turn of acpConversationOrderedPaginatedPageSchema.parse(restored).turns)
        restoredTurns.set(turn.turnId, turn);
    }
    expect(
      [...restoredTurns.values()]
        .sort((a, b) => a.turnOrder - b.turnOrder)
        .map((turn) => [turn.turnId, turn.turnOrder])
    ).toEqual(before.map((turn) => [turn.turnId, turn.turnOrder]));
  });
});
