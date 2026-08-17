import { describe, expect, it } from "vitest";

export type AcpAdapterConformanceScenario =
  | "success"
  | "refusal"
  | "max_tokens"
  | "max_turn_requests"
  | "nontext-output"
  | "long-prompt"
  | "close-capable-error"
  | "private-overlong-process-error";

export type AcpAdapterConformanceTerminal =
  | { readonly state: "succeeded"; readonly stopReason: string }
  | { readonly state: "cancelled"; readonly failureCategory: "cancelled" }
  | { readonly state: "failed"; readonly failureCategory: string };

export type AcpAdapterConformanceObservation = {
  readonly terminal: AcpAdapterConformanceTerminal;
  readonly productTexts: readonly string[];
  readonly events: readonly {
    readonly sequence: number;
    readonly kind: string;
    readonly state?: string;
  }[];
  readonly publicFailure?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
};

export type AcpAdapterConformanceHarness = {
  readonly exposesRemotePublicFailure: boolean;
  run(scenario: AcpAdapterConformanceScenario): Promise<AcpAdapterConformanceObservation>;
};

function eventPosition(
  events: AcpAdapterConformanceObservation["events"],
  predicate: (event: AcpAdapterConformanceObservation["events"][number]) => boolean
): number {
  return events.findIndex(predicate);
}

export function defineAcpExecutionAdapterConformance(
  name: string,
  harness: AcpAdapterConformanceHarness
): void {
  describe(`${name} ACP adapter conformance`, () => {
    it("completes end_turn and exposes normalized events in engine order", async () => {
      const observation = await harness.run("success");

      expect(observation.terminal).toEqual({ state: "succeeded", stopReason: "end_turn" });
      expect(observation.productTexts).toHaveLength(1);
      expect(observation.productTexts[0]).toMatch(/^hello from mock-session-/);
      expect(observation.events.map((event) => event.sequence)).toEqual(
        observation.events.map((_event, index) => index + 1)
      );

      const connecting = eventPosition(
        observation.events,
        (event) => event.kind === "lifecycle" && event.state === "connecting"
      );
      const running = eventPosition(
        observation.events,
        (event) => event.kind === "lifecycle" && event.state === "running"
      );
      const cleanup = eventPosition(
        observation.events,
        (event) => event.kind === "lifecycle" && event.state === "cleanup"
      );
      const terminal = eventPosition(observation.events, (event) => event.kind === "terminal");

      expect(connecting).toBe(0);
      expect(running).toBeGreaterThan(connecting);
      expect(cleanup).toBeGreaterThan(running);
      expect(terminal).toBeGreaterThan(cleanup);
      expect(terminal).toBe(observation.events.length - 1);
    });

    it.each([
      "refusal",
      "max_tokens",
      "max_turn_requests"
    ] as const)("classifies %s as an incomplete response without producing an artifact", async (scenario) => {
      const observation = await harness.run(scenario);

      expect(observation.terminal).toEqual({
        state: "failed",
        failureCategory: "incomplete_response"
      });
      expect(observation.productTexts).toEqual([]);
    });

    it("uses only raw assistant text as the product", async () => {
      const observation = await harness.run("nontext-output");

      expect(observation.terminal).toEqual({ state: "succeeded", stopReason: "end_turn" });
      expect(observation.productTexts).toEqual(["TOKEN=super-secret"]);
      expect(observation.productTexts.join("\n")).not.toContain("image/png");
      expect(observation.productTexts.join("\n")).not.toContain("AAAA");
    });

    it("classifies cancellation without producing an artifact", async () => {
      const observation = await harness.run("long-prompt");

      expect(observation.terminal).toEqual({
        state: "cancelled",
        failureCategory: "cancelled"
      });
      expect(observation.productTexts).toEqual([]);
    });

    it("keeps a successful product when session close fails during cleanup", async () => {
      const observation = await harness.run("close-capable-error");

      expect(observation.terminal).toEqual({
        state: "succeeded",
        stopReason: "end_turn"
      });
      expect(observation.productTexts).toHaveLength(1);
      expect(observation.productTexts[0]).toMatch(/^hello from mock-session-/);
    });

    it("classifies private overlong process failure without leaking it remotely", async () => {
      const observation = await harness.run("private-overlong-process-error");

      expect(observation.terminal).toEqual({
        state: "failed",
        failureCategory: "process_error"
      });
      expect(observation.productTexts).toEqual([]);
      if (harness.exposesRemotePublicFailure) {
        expect(observation.publicFailure).toMatchObject({
          code: "acp_process_error",
          retryable: false
        });
        expect(observation.publicFailure?.message).toMatch(/^The ACP process failed\./);
        expect(JSON.stringify(observation.publicFailure)).not.toContain("private-worktree");
        expect(JSON.stringify(observation.publicFailure)).not.toContain("raw-secret");
        expect(observation.publicFailure?.message.length).toBeLessThanOrEqual(16_384);
      }
    });
  });
}
