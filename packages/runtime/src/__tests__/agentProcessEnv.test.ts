import { describe, expect, it } from "vitest";
import { agentProcessEnv, agentProcessPath } from "../process/agentProcessEnv.js";

describe("agentProcessEnv", () => {
  it("uses POSIX delimiters and Homebrew fallbacks", () => {
    expect(agentProcessPath("/usr/bin:/bin", "darwin").split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin"
    ]);
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
});
