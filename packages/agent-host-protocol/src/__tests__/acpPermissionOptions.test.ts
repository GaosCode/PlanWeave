import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACP_PERMISSION_OPTION_ID_MAX_BYTES,
  ACP_PERMISSION_OPTION_LABEL_MAX_LENGTH,
  ACP_PERMISSION_OPTION_MAX_COUNT,
  EXACT_PERMISSION_OPTIONS_VERSION_HEADER,
  acpPermissionOptionsSchema,
  canonicalizeJson,
  exactPermissionRequestSchema,
  exactPermissionSelectionSchema,
  historicalPermissionRequestSchema,
  historicalPermissionSettlementSchema,
  negotiateExactPermissionOptionsVersion,
  parseExactPermissionSettlementForRequest,
  permissionRequestCompatibility,
  requireExactPermissionOptionsVersion,
  selectedAcpPermissionOptionId
} from "../index.js";
import * as browser from "../browser.js";

const identity = {
  dispatchId: "dispatch-1",
  leaseId: "lease-1",
  executionAttemptId: "attempt-1",
  acpSessionId: "session-1",
  actionId: "action-1"
};
const options = [
  { optionId: "always", label: "Always allow", kind: "allow_always" },
  { optionId: "once", label: "Allow once", kind: "allow_once" },
  { optionId: "other-once", label: "Allow this path", kind: "allow_once" },
  { optionId: "reject-forever", label: "Always reject", kind: "reject_always" }
];
const legacyRequest = {
  ...identity,
  expiresAt: "2030-01-01T00:00:00.000Z",
  type: "interaction.permission_requested",
  title: "Run tool",
  description: "Permission required"
};
const request = { ...legacyRequest, options };
const response = {
  ...identity,
  type: "interaction.permission_response",
  decision: "select_option",
  optionId: "once"
};

describe("exact ACP permission options", () => {
  it("exports the same leaf contracts for Node and browser consumers", () => {
    expect(browser.acpPermissionOptionsSchema).toBe(acpPermissionOptionsSchema);
    expect(browser.exactPermissionSelectionSchema).toBe(exactPermissionSelectionSchema);
    expect(browser.parseExactPermissionSettlementForRequest).toBe(
      parseExactPermissionSettlementForRequest
    );
  });

  it.each([
    { ordered: options },
    { ordered: [...options].reverse() }
  ])("selects by exact ID regardless of order", ({ ordered }) => {
    expect(
      parseExactPermissionSettlementForRequest({ ...request, options: ordered }, response)
    ).toEqual(response);
    expect(
      selectedAcpPermissionOptionId(ordered, { decision: "select_option", optionId: "other-once" })
    ).toBe("other-once");
  });

  it("preserves explicit reject IDs while generic deny cancels", () => {
    const ordered = [options[3], options[0]];
    expect(selectedAcpPermissionOptionId(ordered, { decision: "deny" })).toBeNull();
    expect(
      selectedAcpPermissionOptionId(ordered, {
        decision: "select_option",
        optionId: "reject-forever"
      })
    ).toBe("reject-forever");
    expect(() =>
      selectedAcpPermissionOptionId([options[0]], { decision: "select_option", optionId: "once" })
    ).toThrow("interaction_permission_option_unknown");
  });

  it("keeps arbitrary valid ACP IDs unchanged with a UTF-8 byte bound", () => {
    const optionId = "允许 / path?option=1";
    const unicode = [{ ...options[0], optionId }];
    expect(selectedAcpPermissionOptionId(unicode, { decision: "select_option", optionId })).toBe(
      optionId
    );
    expect(
      acpPermissionOptionsSchema.parse([
        { ...options[0], optionId: "😀".repeat(ACP_PERMISSION_OPTION_ID_MAX_BYTES / 4) }
      ])
    ).toHaveLength(1);
  });

  it("rejects invalid option lists", () => {
    const invalidLists = [
      [],
      [...options, options[0]],
      [{ ...options[0], kind: "approve" }],
      [{ ...options[0], optionId: "" }],
      [{ ...options[0], optionId: "😀".repeat(ACP_PERMISSION_OPTION_ID_MAX_BYTES / 4 + 1) }],
      [{ ...options[0], optionId: "\ud800" }],
      [{ ...options[0], label: "" }],
      [{ ...options[0], label: "x".repeat(ACP_PERMISSION_OPTION_LABEL_MAX_LENGTH + 1) }],
      Array.from({ length: ACP_PERMISSION_OPTION_MAX_COUNT + 1 }, (_, n) => ({
        ...options[0],
        optionId: String(n)
      }))
    ];
    for (const invalid of invalidLists) {
      expect(acpPermissionOptionsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each([
    "dispatchId",
    "leaseId",
    "executionAttemptId",
    "acpSessionId",
    "actionId"
  ])("rejects mismatched %s", (field) => {
    expect(() =>
      parseExactPermissionSettlementForRequest(request, { ...response, [field]: "wrong" })
    ).toThrow("interaction_identity_mismatch");
  });

  it("rejects forged IDs, stale allow_once decisions, and client-supplied scope", () => {
    expect(() =>
      parseExactPermissionSettlementForRequest(request, { ...response, optionId: "forged" })
    ).toThrow("interaction_permission_option_unknown");
    expect(() =>
      parseExactPermissionSettlementForRequest(request, {
        ...identity,
        type: response.type,
        decision: "allow_once"
      })
    ).toThrow();
    expect(() =>
      parseExactPermissionSettlementForRequest(request, { ...response, kind: "allow_once" })
    ).toThrow();
    expect(
      exactPermissionSelectionSchema.safeParse({ decision: "deny", optionId: "reject-forever" })
        .success
    ).toBe(false);
  });
});

describe("permission history and capability boundaries", () => {
  it("keeps old request and settlement objects and their fingerprints unchanged", () => {
    const settlement = { ...identity, type: response.type, decision: "allow_once" };
    for (const [before, after] of [
      [legacyRequest, historicalPermissionRequestSchema.parse(legacyRequest)],
      [settlement, historicalPermissionSettlementSchema.parse(settlement)],
      [request, historicalPermissionRequestSchema.parse(request)],
      [response, historicalPermissionSettlementSchema.parse(response)]
    ]) {
      expect(after).toEqual(before);
      const hash = (input: unknown) =>
        createHash("sha256").update(canonicalizeJson(input)).digest("hex");
      expect(hash(after)).toBe(hash(before));
    }
    expect(permissionRequestCompatibility(legacyRequest)).toBe("legacy_missing_options");
    expect(permissionRequestCompatibility(request)).toBe("exact");
    expect(exactPermissionRequestSchema.safeParse(legacyRequest).success).toBe(false);
  });

  it("never grants or emits deny from an old request with missing options", () => {
    expect(() => parseExactPermissionSettlementForRequest(legacyRequest, response)).toThrow(
      "legacy_permission_request_requires_execution_cancel"
    );
    expect(() =>
      parseExactPermissionSettlementForRequest(legacyRequest, {
        ...identity,
        type: response.type,
        decision: "deny"
      })
    ).toThrow("legacy_permission_request_requires_execution_cancel");
    expect(
      historicalPermissionRequestSchema.safeParse({ ...request, options: undefined }).success
    ).toBe(false);
    expect(historicalPermissionRequestSchema.safeParse({ ...request, options: [] }).success).toBe(
      false
    );
    expect(
      historicalPermissionRequestSchema.safeParse({
        ...request,
        options: [{ ...options[0], kind: "unknown" }]
      }).success
    ).toBe(false);
  });

  it("distinguishes old Hosts, exact support, and unsupported capabilities", () => {
    expect(EXACT_PERMISSION_OPTIONS_VERSION_HEADER).toBe(
      "x-planweave-exact-permission-options-version"
    );
    expect(negotiateExactPermissionOptionsVersion(undefined)).toBeUndefined();
    expect(negotiateExactPermissionOptionsVersion("1")).toBe(1);
    expect(() => requireExactPermissionOptionsVersion(1)).not.toThrow();
    for (const value of [undefined, null, "1", 0, 2]) {
      expect(() => requireExactPermissionOptionsVersion(value)).toThrow(
        "exact_permission_options_unsupported"
      );
    }
    for (const header of [null, "", "2", "1, 1", ["1", "1"]]) {
      expect(() => negotiateExactPermissionOptionsVersion(header)).toThrow(
        "exact_permission_options_unsupported"
      );
    }
  });
});
