import { describe, expect, it } from "vitest";
import { acpCreditsSemantics, projectAcpCreditsUsage } from "../autoRun/acpCreditsProjection.js";

type Cost = {
  amount: number;
  currency: string | null;
  unit?: "currency" | "credits" | "unknown";
};

function usage(sequence: number, cost: Cost | null) {
  return {
    sequence,
    body: {
      kind: "usage_update" as const,
      usedTokens: 0,
      contextWindowTokens: 0,
      cost
    }
  };
}

describe("projectAcpCreditsUsage", () => {
  it("reports unavailable when the run carries no credit samples", () => {
    expect(projectAcpCreditsUsage([usage(1, null)], { agentId: "codebuddy" })).toMatchObject({
      availability: "unavailable"
    });
  });

  it("ignores monetary costs", () => {
    expect(
      projectAcpCreditsUsage([usage(1, { amount: 1.97, currency: "USD", unit: "currency" })], {
        agentId: "codebuddy"
      })
    ).toMatchObject({ availability: "unavailable" });
  });

  it("totals the samples once the semantics are verified as deltas", () => {
    const usageSummary = projectAcpCreditsUsage(
      [
        usage(1, { amount: 0.59, currency: null, unit: "credits" }),
        usage(2, { amount: 0.55, currency: null, unit: "credits" }),
        usage(3, { amount: 0.66, currency: null, unit: "credits" })
      ],
      { agentId: "codebuddy" }
    );
    expect(usageSummary).toMatchObject({
      availability: "reported",
      lastReportedCredits: 0.66,
      sampleCount: 3,
      totalCredits: 1.8,
      semantics: "delta"
    });
  });

  it("withholds a total for an agent whose semantics are unknown", () => {
    expect(
      projectAcpCreditsUsage(
        [
          usage(1, { amount: 0.59, currency: null, unit: "credits" }),
          usage(2, { amount: 0.66, currency: null, unit: "credits" })
        ],
        { agentId: "codex" }
      )
    ).toMatchObject({
      availability: "reported",
      lastReportedCredits: 0.66,
      sampleCount: 2,
      totalCredits: null,
      semantics: "unknown"
    });
  });

  it("takes the newest sample even when events arrive out of order", () => {
    expect(
      projectAcpCreditsUsage(
        [
          usage(9, { amount: 2, currency: null, unit: "credits" }),
          usage(4, { amount: 1, currency: null, unit: "credits" })
        ],
        { agentId: "codebuddy" }
      )
    ).toMatchObject({ lastReportedCredits: 2, sampleCount: 2 });
  });

  it("falls back to unknown semantics for an unrecognised agent", () => {
    expect(acpCreditsSemantics("codex")).toMatchObject({ kind: "unknown", verified: false });
    expect(acpCreditsSemantics(null)).toMatchObject({ kind: "unknown", verified: false });
    expect(acpCreditsSemantics("codebuddy")).toMatchObject({ kind: "delta" });
  });
});
