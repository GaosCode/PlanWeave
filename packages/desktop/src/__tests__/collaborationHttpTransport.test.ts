import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { CollaborationHttpTransport } from "../main/collaboration/collaborationHttpTransport.js";

describe("CollaborationHttpTransport", () => {
  it("keeps the JSON request deadline active while reading the response body", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'));
            signal?.addEventListener(
              "abort",
              () => controller.error(new Error("request_aborted")),
              { once: true }
            );
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const transport = new CollaborationHttpTransport({
      serverBaseUrl: "http://127.0.0.1:43123/",
      credential: { getDeviceToken: () => "pw_hdev_test" },
      limits: { requestTimeoutMs: 20 },
      request
    });
    const requestOutcome = transport.json("GET", "/status", z.object({ ok: z.boolean() })).then(
      () => ({ code: "unexpected_success" }),
      (error: unknown) => ({
        code: error instanceof Error && "code" in error ? String(error.code) : "unknown_error"
      })
    );

    try {
      const outcome = await Promise.race([
        requestOutcome,
        new Promise<{ code: string }>((resolve) =>
          setTimeout(() => resolve({ code: "still_pending" }), 100)
        )
      ]);
      expect(outcome).toEqual({ code: "collaboration_timeout" });
    } finally {
      transport.dispose();
    }
  });
});
