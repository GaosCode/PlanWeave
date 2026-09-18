import { describe, expect, it } from "vitest";
import * as browser from "../browser.js";
import {
  historicalPermissionHostReplaySchema,
  historicalPermissionMailboxReplaySchema,
  negotiateHistoricalPermissionReplayVersion,
  parseHistoricalPermissionEventJson
} from "../historicalPermissionReplay.js";
import { hostEventSchema, mailboxDeliverySchema, serverEventSchema } from "../agentHostProtocol.js";

const identity = {
  dispatchId: "old-dispatch",
  leaseId: "old-lease",
  executionAttemptId: "old-attempt",
  acpSessionId: "old-session",
  actionId: "old-action"
};
const request = {
  ...identity,
  type: "interaction.permission_requested",
  protocolVersion: 1,
  messageId: "old-message",
  title: "Permission",
  description: "Persisted without options",
  expiresAt: "2030-01-01T00:00:00.000Z"
};
const response = { ...identity, type: "interaction.permission_response", decision: "allow_once" };
const mailbox = {
  type: "mailbox.permission_history",
  protocolVersion: 1,
  sequence: 2,
  previousSequence: 1,
  messageId: "old-mailbox",
  commandJson: JSON.stringify(response, null, 2)
};

describe("historical permission replay wire boundary", () => {
  it("negotiates history independently without changing the exact permission protocol", () => {
    expect(browser.historicalPermissionHostReplaySchema).toBe(historicalPermissionHostReplaySchema);
    expect(browser.historicalPermissionMailboxReplaySchema).toBe(
      historicalPermissionMailboxReplaySchema
    );
    expect(negotiateHistoricalPermissionReplayVersion(undefined)).toBeUndefined();
    expect(negotiateHistoricalPermissionReplayVersion("1")).toBe(1);
    for (const value of ["0", "2", ["1"], 1])
      expect(() => negotiateHistoricalPermissionReplayVersion(value)).toThrow(
        "historical_permission_replay_unsupported"
      );
  });

  it("preserves raw JSON while keeping historical requests out of the live event schema", () => {
    const eventJson = JSON.stringify(request, null, 2);
    const replay = historicalPermissionHostReplaySchema.parse({
      type: "host.permission_history",
      protocolVersion: 1,
      eventJson
    });
    expect(replay.eventJson).toBe(eventJson);
    expect(parseHistoricalPermissionEventJson(replay.eventJson)).toEqual(request);
    expect(hostEventSchema.safeParse(request).success).toBe(false);
    expect(hostEventSchema.safeParse(replay).success).toBe(false);
    expect(
      historicalPermissionHostReplaySchema.safeParse({ ...replay, eventJson: "{" }).success
    ).toBe(false);
    expect(
      historicalPermissionHostReplaySchema.safeParse({
        ...replay,
        eventJson: JSON.stringify({
          ...request,
          options: [{ optionId: "provider-choice", label: "Allow", kind: "allow_once" }]
        })
      }).success
    ).toBe(false);
  });

  it("only admits the obsolete decision as explicit non-executable mailbox history", () => {
    expect(serverEventSchema.parse(mailbox)).toEqual(mailbox);
    expect(
      mailboxDeliverySchema.safeParse({
        ...mailbox,
        type: "mailbox.message",
        commandJson: undefined,
        command: response
      }).success
    ).toBe(false);
    for (const decision of ["deny", "select_option", "allow_always"]) {
      expect(
        historicalPermissionMailboxReplaySchema.safeParse({
          ...mailbox,
          commandJson: JSON.stringify({ ...response, decision })
        }).success
      ).toBe(false);
    }
    expect(
      historicalPermissionMailboxReplaySchema.safeParse({
        ...mailbox,
        commandJson: JSON.stringify({ ...response, optionId: "invented" })
      }).success
    ).toBe(false);
  });
});
