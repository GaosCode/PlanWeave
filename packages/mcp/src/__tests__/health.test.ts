import { describe, expect, it } from "vitest";
import { createHealthPayload } from "../health.js";

describe("createHealthPayload", () => {
  it("does not expose token or PLANWEAVE_HOME path", () => {
    const payload = createHealthPayload({
      host: "127.0.0.1",
      port: 8787,
      token: "secret-token",
      planweaveHomeFromEnv: true
    });

    expect(payload).toEqual({
      status: "ok",
      host: "127.0.0.1",
      port: 8787,
      tokenAuthEnabled: true,
      planweaveHomeFromEnv: true
    });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
    expect(JSON.stringify(payload)).not.toContain("/tmp");
  });
});
