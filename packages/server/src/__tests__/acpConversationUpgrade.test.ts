import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { acpConversationOrderedPageSchema } from "@planweave-ai/agent-host-protocol";
import { acpConversationWirePage } from "../acpConversationPagination.js";
import { AcpConversationService } from "../acpConversationService.js";
import { AgentHostRepository } from "../hosts.js";
import { startPlanweaveServer } from "../lifecycle.js";
import { DurableMailbox } from "../mailbox.js";
import { createAcpConversationFixture } from "./support/acpConversationFixture.js";

const fixtures: Awaited<ReturnType<typeof createAcpConversationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function setup(completed = true) {
  const f = await createAcpConversationFixture();
  fixtures.push(f);
  f.service.act(f.operation, "actor", f.prompt);
  if (completed) {
    f.service.ingest(f.host.id, f.event(1, { kind: "status", status: "completed", error: null }));
  }
  f.db
    .prepare(
      "UPDATE mailbox_messages SET command_json=json_set(command_json,'$.protocolVersion',1) WHERE host_id=?"
    )
    .run(f.host.id);
  f.db
    .prepare(
      "UPDATE acp_conversation_events SET event_json=json_set(event_json,'$.protocolVersion',1) WHERE turn_id=?"
    )
    .run(f.prompt.turnId);
  return f;
}

describe("Server conversation history after a wire protocol upgrade", () => {
  it("reopens a database containing v1 history and reads it through fresh repositories", async () => {
    const f = await setup();
    const events = f.db
      .prepare("SELECT event_json FROM acp_conversation_events ORDER BY cursor")
      .all();
    fixtures.splice(fixtures.indexOf(f), 1);
    f.server.close();
    const server = await startPlanweaveServer(f.server.config);
    fixtures.push({ ...f, server });
    const service = new AcpConversationService(server.database, {
      hosts: new AgentHostRepository(server.database, f.clock),
      mailbox: new DurableMailbox(server.database),
      hostOfflineAfterMs: 60_000,
      clock: f.clock,
      authorize: f.authorize
    });
    const page = service.page(f.operation, "actor");
    expect(page.events).toMatchObject([{ protocolVersion: 1, turnId: f.prompt.turnId }]);
    expect(page.available).toBe(false);
    expect(
      server.database
        .prepare("SELECT event_json FROM acp_conversation_events ORDER BY cursor")
        .all()
    ).toEqual(events);
  });

  it.each([
    1, 2, 3
  ] as const)("reads v1 history through page format %i without rewriting or replaying it", async (version) => {
    const f = await setup();
    const before = f.db.prepare("SELECT * FROM acp_conversation_events ORDER BY cursor").all();
    const mailbox = f.db.prepare("SELECT * FROM mailbox_messages ORDER BY sequence").all();
    const page = f.service.page(f.operation, "actor", 0, null, undefined, version);
    expect(acpConversationOrderedPageSchema.parse(page)).toMatchObject({
      available: false,
      reason: "protocol_version_incompatible_upgrade_required",
      turns: [{ turnId: f.prompt.turnId, status: "completed" }],
      events: [{ protocolVersion: 1, turnId: f.prompt.turnId, sequence: 1 }]
    });
    expect(acpConversationWirePage(page, version).events).toEqual(page.events);
    expect(f.service.page(f.operation, "actor", page.cursor).events).toEqual([]);
    expect(() =>
      f.service.act(f.operation, "actor", { ...f.prompt, turnId: "must-not-replay" })
    ).toThrow("protocol_version_incompatible_upgrade_required");
    expect(f.db.prepare("SELECT * FROM acp_conversation_events ORDER BY cursor").all()).toEqual(
      before
    );
    expect(f.db.prepare("SELECT * FROM mailbox_messages ORDER BY sequence").all()).toEqual(mailbox);
  });

  it("closes an old queued turn explicitly instead of leaving it running after Host upgrade", async () => {
    const f = await setup(false);
    const page = f.service.page(f.operation, "actor");
    expect(page.turns).toContainEqual(
      expect.objectContaining({
        turnId: f.prompt.turnId,
        status: "failed",
        error: "stored_command_protocol_incompatible"
      })
    );
    expect(page.available).toBe(false);
    expect(page.canRestoreTask).toBe(false);
    expect(f.service.page(f.operation, "actor").turns).toEqual(page.turns);
  });

  it("still rejects malformed stored events and live v1 events", async () => {
    const f = await setup();
    const archived = JSON.parse(
      String(f.db.prepare("SELECT event_json FROM acp_conversation_events").get()?.event_json)
    );
    expect(() => f.service.ingest(f.host.id, archived)).toThrow(/protocol/);
    f.db
      .prepare(
        "UPDATE acp_conversation_events SET event_json=json_set(event_json,'$.unexpected',true)"
      )
      .run();
    expect(() => f.service.page(f.operation, "actor")).toThrow();
  });
});
