import { describe, expect, it } from "vitest";
import { projectAcpContextUsage } from "../autoRun/acpUsageProjection.js";

type UsageCost = {
  amount: number;
  currency: string | null;
  unit?: "currency" | "credits" | "unknown";
};

type UsageEvent = {
  sequence: number;
  timestamp: string;
  body: {
    kind: "usage_update";
    usedTokens: number;
    contextWindowTokens: number;
    cost: UsageCost | null;
  };
};

function usage(
  sequence: number,
  usedTokens: number,
  contextWindowTokens: number,
  cost: UsageCost | null = null
): UsageEvent {
  return {
    sequence,
    timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    body: { kind: "usage_update", usedTokens, contextWindowTokens, cost }
  };
}

describe("projectAcpContextUsage", () => {
  it("returns null when the stream carries no usage updates", () => {
    expect(projectAcpContextUsage([])).toBeNull();
    expect(
      projectAcpContextUsage([
        {
          sequence: 1,
          timestamp: "2026-01-01T00:00:01.000Z",
          body: { kind: "message", role: "assistant", messageId: null, content: "hi" }
        }
      ] as never)
    ).toBeNull();
  });

  it("keeps the last reported window and token count when the agent closes with a zero payload", () => {
    const snapshot = projectAcpContextUsage([
      usage(1, 0, 176_000),
      usage(2, 51_273, 176_000),
      usage(3, 0, 0)
    ]);
    expect(snapshot).toMatchObject({
      usedTokens: 51_273,
      contextWindowTokens: 176_000,
      sequence: 3
    });
  });

  it("honours a genuine reset that reports an empty context but a known window", () => {
    expect(projectAcpContextUsage([usage(1, 51_273, 176_000), usage(2, 0, 176_000)])).toMatchObject(
      { usedTokens: 0, contextWindowTokens: 176_000 }
    );
  });

  it("carries a cost forward when the terminal update omits it", () => {
    expect(
      projectAcpContextUsage([usage(1, 10, 100, { amount: 0.59, currency: "USD" }), usage(2, 0, 0)])
    ).toMatchObject({ cost: { amount: 0.59, currency: "USD" }, sequence: 2 });
  });

  it("takes the newest sample of each field regardless of arrival order", () => {
    expect(
      projectAcpContextUsage([
        usage(5, 80, 200, { amount: 2, currency: "USD" }),
        usage(3, 40, 100),
        usage(7, 0, 0)
      ])
    ).toMatchObject({
      usedTokens: 80,
      contextWindowTokens: 200,
      cost: { amount: 2, currency: "USD" },
      sequence: 7,
      observedAt: "2026-01-01T00:00:07.000Z"
    });
  });

  it("reports zeros when the agent never advertised a window", () => {
    expect(projectAcpContextUsage([usage(1, 0, 0)])).toMatchObject({
      usedTokens: 0,
      contextWindowTokens: 0,
      cost: null
    });
  });

  it("keeps a credit amount that carries no currency", () => {
    expect(projectAcpContextUsage([usage(1, 0, 0, { amount: 0.66, currency: "" })])).toMatchObject({
      cost: { amount: 0.66, currency: null, unit: "credits" }
    });
  });

  it("keeps an unformattable amount but marks its unit unknown", () => {
    expect(projectAcpContextUsage([usage(1, 0, 0, { amount: 1.5, currency: "US" })])).toMatchObject(
      { cost: { amount: 1.5, currency: null, unit: "unknown" } }
    );
  });

  it("formats a three-letter currency as money", () => {
    expect(
      projectAcpContextUsage([usage(1, 0, 0, { amount: 1.97, currency: "USD" })])
    ).toMatchObject({ cost: { amount: 1.97, currency: "USD", unit: "currency" } });
  });

  it("drops a cost whose amount is not a finite number", () => {
    expect(
      projectAcpContextUsage([usage(1, 0, 0, { amount: Number.NaN, currency: "USD" })])
    ).toMatchObject({ cost: null });
  });
});
