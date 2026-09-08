import { describe, expect, it } from "vitest";
import {
  CANVAS_PRESENCE_COORDINATE_ABS_MAX,
  CANVAS_PRESENCE_MAX_SELECTION_IDS,
  CANVAS_PRESENCE_PROTOCOL_VERSION
} from "../limits.js";
import {
  canvasPresenceClientMessageSchema,
  canvasPresenceServerMessageSchema
} from "../presence.js";

const scope = {
  protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
  projectId: "project-1",
  canvasId: "default"
} as const;

const identity = {
  sessionId: "session-1",
  humanPrincipalId: "human-1",
  displayName: "Ada"
} as const;

describe("canvas presence contracts", () => {
  it("accepts bounded client hello and flow-coordinate updates", () => {
    expect(
      canvasPresenceClientMessageSchema.parse({
        type: "canvas.presence.hello",
        ...scope
      }).type
    ).toBe("canvas.presence.hello");
    expect(
      canvasPresenceClientMessageSchema.parse({
        type: "canvas.presence.update",
        ...scope,
        pointer: { x: -42.5, y: CANVAS_PRESENCE_COORDINATE_ABS_MAX },
        selectionIds: ["T-001", "T-001-depends_on-T-002"]
      }).type
    ).toBe("canvas.presence.update");
  });

  it("rejects unsupported versions, unknown fields, and forged client identity", () => {
    const hello = { type: "canvas.presence.hello", ...scope } as const;
    expect(() =>
      canvasPresenceClientMessageSchema.parse({ ...hello, protocolVersion: 2 })
    ).toThrow();
    expect(() => canvasPresenceClientMessageSchema.parse({ ...hello, extra: true })).toThrow();
    expect(() =>
      canvasPresenceClientMessageSchema.parse({
        type: "canvas.presence.update",
        ...scope,
        pointer: null,
        selectionIds: [],
        identity
      })
    ).toThrow();
  });

  it("rejects non-finite, out-of-range, duplicate, and oversized updates", () => {
    const update = {
      type: "canvas.presence.update",
      ...scope,
      pointer: { x: 1, y: 2 },
      selectionIds: ["T-001"]
    } as const;
    expect(() =>
      canvasPresenceClientMessageSchema.parse({ ...update, pointer: { x: Number.NaN, y: 0 } })
    ).toThrow();
    expect(() =>
      canvasPresenceClientMessageSchema.parse({
        ...update,
        pointer: { x: CANVAS_PRESENCE_COORDINATE_ABS_MAX + 1, y: 0 }
      })
    ).toThrow();
    expect(() =>
      canvasPresenceClientMessageSchema.parse({ ...update, selectionIds: ["T-001", "T-001"] })
    ).toThrow();
    expect(() =>
      canvasPresenceClientMessageSchema.parse({
        ...update,
        selectionIds: Array.from(
          { length: CANVAS_PRESENCE_MAX_SELECTION_IDS + 1 },
          (_, index) => `T-${index}`
        )
      })
    ).toThrow();
  });

  it("accepts only server-projected identity in snapshots, updates, and leaves", () => {
    const session = { identity, pointer: { x: 10, y: 20 }, selectionIds: ["T-001"] };
    expect(
      canvasPresenceServerMessageSchema.parse({
        type: "canvas.presence.snapshot",
        ...scope,
        sessions: [session]
      }).type
    ).toBe("canvas.presence.snapshot");
    expect(
      canvasPresenceServerMessageSchema.parse({
        type: "canvas.presence.update",
        ...scope,
        session
      }).type
    ).toBe("canvas.presence.update");
    expect(
      canvasPresenceServerMessageSchema.parse({
        type: "canvas.presence.leave",
        ...scope,
        sessionId: identity.sessionId
      }).type
    ).toBe("canvas.presence.leave");
    expect(() =>
      canvasPresenceServerMessageSchema.parse({
        type: "canvas.presence.snapshot",
        ...scope,
        sessions: [session, session]
      })
    ).toThrow();
    expect(() =>
      canvasPresenceServerMessageSchema.parse({
        type: "canvas.presence.update",
        ...scope,
        session: {
          ...session,
          identity: { ...identity, displayName: "Ada\u0000" }
        }
      })
    ).toThrow();
  });

  it("keeps errors bounded to stable codes without free-form payloads", () => {
    const error = {
      type: "canvas.presence.error",
      ...scope,
      code: "unknown_canvas"
    } as const;
    expect(canvasPresenceServerMessageSchema.parse(error)).toEqual(error);
    expect(() =>
      canvasPresenceServerMessageSchema.parse({ ...error, message: "prompt content" })
    ).toThrow();
  });
});

it("validates diagnostic correlation and rejects forged server timing from clients", () => {
  const trace = { streamId: "12345678-1234-4234-8234-123456789012", sequence: 3 };
  const base = {
    type: "canvas.presence.update",
    protocolVersion: 1,
    projectId: "project-demo-001",
    canvasId: "default",
    pointer: null,
    selectionIds: []
  };
  expect(canvasPresenceClientMessageSchema.safeParse({ ...base, trace }).success).toBe(true);
  expect(
    canvasPresenceClientMessageSchema.safeParse({ ...base, trace: { ...trace, sequence: -1 } })
      .success
  ).toBe(false);
  expect(
    canvasPresenceClientMessageSchema.safeParse({
      ...base,
      trace: { ...trace, serverReceivedMs: 0 }
    }).success
  ).toBe(false);
});
