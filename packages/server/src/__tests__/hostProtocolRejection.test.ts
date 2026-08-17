import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logHostProtocolRejection, publicHostProtocolRejection } from "../hostProtocolRejection.js";

describe("publicHostProtocolRejection", () => {
  it("returns stable machine codes for known host protocol failures", () => {
    expect(publicHostProtocolRejection(new Error("invalid_json"))).toEqual({
      code: "invalid_json",
      message: "invalid_json"
    });
    expect(publicHostProtocolRejection(new Error("mailbox_cursor_not_acknowledged"))).toMatchObject(
      {
        code: "mailbox_cursor_not_acknowledged",
        message: expect.stringContaining("lastAcknowledgedSequence")
      }
    );
    expect(publicHostProtocolRejection(new Error("host_event_unsupported:lease.renew"))).toEqual({
      code: "host_event_unsupported:lease.renew",
      message: "Host event type is not supported by this Server: lease.renew"
    });
  });

  it("summarizes Zod validation failures without including received values", () => {
    const schema = z
      .object({
        type: z.literal("host.heartbeat"),
        secret: z.string()
      })
      .strict();
    let error: z.ZodError;
    try {
      schema.parse({ type: "host.hello", secret: "pw_op_super_secret_token_value" });
      throw new Error("expected_zod_error");
    } catch (caught) {
      if (!(caught instanceof z.ZodError)) throw caught;
      error = caught;
    }
    const rejection = publicHostProtocolRejection(error);
    expect(rejection.code).toBe("schema_invalid");
    expect(rejection.message).toContain("schema validation");
    expect(rejection.message).toContain("type:");
    expect(rejection.message).not.toContain("pw_op_super_secret_token_value");
    expect(rejection.message).not.toContain("host.hello");
  });

  it("redacts free-form errors that may contain paths or secrets", () => {
    const rejection = publicHostProtocolRejection(
      new Error(`/Users/private/server.sqlite token=server-secret-value ${"x".repeat(200)}`)
    );
    expect(rejection).toEqual({
      code: "event_rejected",
      message: "The server rejected the host event."
    });
    expect(JSON.stringify(rejection)).not.toContain("server.sqlite");
    expect(JSON.stringify(rejection)).not.toContain("server-secret-value");
  });

  it("logs a compact operator record without stack, secrets, or unbounded text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const publicRejection = publicHostProtocolRejection(
        new Error("mailbox_cursor_not_acknowledged")
      );
      logHostProtocolRejection({
        hostId: "host-1",
        phase: "hello",
        error: new Error("mailbox_cursor_not_acknowledged"),
        publicRejection
      });
      expect(spy).toHaveBeenCalledOnce();
      const payload = JSON.parse(String(spy.mock.calls[0]?.[0]));
      expect(payload).toMatchObject({
        scope: "agent-host-ws",
        event: "host_event_rejected",
        hostId: "host-1",
        phase: "hello",
        publicCode: "mailbox_cursor_not_acknowledged",
        error: { name: "Error", summary: "mailbox_cursor_not_acknowledged" }
      });
      expect(payload.error).not.toHaveProperty("stack");
      expect(payload.error).not.toHaveProperty("message");

      spy.mockClear();
      const secret = "server-secret-value";
      const leaked = new Error(`/Users/private/server.sqlite token=${secret} ${"x".repeat(400)}`);
      logHostProtocolRejection({
        hostId: "host-2",
        phase: "event",
        error: leaked,
        publicRejection: publicHostProtocolRejection(leaked)
      });
      const dirtyLine = String(spy.mock.calls[0]?.[0]);
      expect(dirtyLine).not.toContain(secret);
      expect(dirtyLine).not.toContain("/Users/private/server.sqlite");
      expect(dirtyLine).toContain("<redacted-user-path>");
      expect(dirtyLine).toContain("token=[REDACTED]");
      expect(dirtyLine.length).toBeLessThan(800);

      spy.mockClear();
      const schema = z
        .object({
          type: z.literal("host.heartbeat"),
          secret: z.string()
        })
        .strict();
      let zodError: z.ZodError;
      try {
        schema.parse({ type: "host.hello", secret: "pw_op_super_secret_token_value" });
        throw new Error("expected_zod_error");
      } catch (caught) {
        if (!(caught instanceof z.ZodError)) throw caught;
        zodError = caught;
      }
      logHostProtocolRejection({
        hostId: "host-3",
        phase: "event",
        error: zodError,
        publicRejection: publicHostProtocolRejection(zodError)
      });
      const zodLine = String(spy.mock.calls[0]?.[0]);
      expect(zodLine).toContain('"name":"ZodError"');
      expect(zodLine).toContain("type:");
      expect(zodLine).not.toContain("pw_op_super_secret_token_value");
      expect(zodLine).not.toContain("host.hello");
    } finally {
      spy.mockRestore();
    }
  });
});
