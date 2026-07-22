import { describe, expect, it } from "vitest";
import {
  agentProcessEnv,
  agentProcessPath,
  setAgentProcessEnvironmentOverlay
} from "../process/agentProcessEnv.js";

describe("agentProcessEnv", () => {
  it("adds common user-level agent install paths on POSIX", () => {
    expect(
      agentProcessPath({
        envPath: "/usr/bin:/bin",
        platform: "darwin",
        env: { HOME: "/Users/example" }
      }).split(":")
    ).toEqual(
      expect.arrayContaining([
        "/Users/example/.local/bin",
        "/Users/example/.grok/bin",
        "/Users/example/.opencode/bin",
        "/Users/example/.bun/bin",
        "/Users/example/.volta/bin",
        "/Users/example/Library/pnpm"
      ])
    );
  });

  it("uses POSIX delimiters and Homebrew fallbacks", () => {
    const entries = agentProcessPath("/usr/bin:/bin", "darwin").split(":");
    expect(entries.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(entries).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin"]));
  });

  it("uses Windows delimiters without POSIX fallbacks", () => {
    expect(
      agentProcessPath({
        envPath: String.raw`C:\Tools;C:\Users\dev\AppData\Roaming\npm`,
        platform: "win32"
      }).split(";")
    ).toEqual([String.raw`C:\Tools`, String.raw`C:\Users\dev\AppData\Roaming\npm`]);
  });

  it("collapses Path/PATH on Windows", () => {
    const env = agentProcessEnv({
      platform: "win32",
      env: {
        Path: String.raw`C:\Tools`,
        PATH: "should-not-survive"
      }
    });
    expect(env.Path).toBe(String.raw`C:\Tools`);
    expect(env.PATH).toBeUndefined();
  });

  it("merges a configured desktop shell environment into every agent process", () => {
    setAgentProcessEnvironmentOverlay({
      PATH: "/Users/example/.nvm/versions/node/v24/bin:/usr/bin:/bin",
      PLANWEAVE_TEST_AGENT_TOKEN: "configured-in-login-shell"
    });
    try {
      const env = agentProcessEnv({ platform: "darwin" });

      expect(env.PATH?.split(":")).toContain("/Users/example/.nvm/versions/node/v24/bin");
      expect(env.PLANWEAVE_TEST_AGENT_TOKEN).toBe("configured-in-login-shell");
    } finally {
      setAgentProcessEnvironmentOverlay(null);
    }
  });
});
