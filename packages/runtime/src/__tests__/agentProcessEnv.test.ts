import { describe, expect, it } from "vitest";
import {
  AgentEnvironmentMissingError,
  agentProcessEnv,
  agentProcessPath,
  resolveAgentProcessEnvironment,
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

  it("adds common user-level agent install paths on Windows", () => {
    expect(
      agentProcessPath({
        envPath: String.raw`C:\Windows\System32`,
        platform: "win32",
        env: {
          USERPROFILE: String.raw`C:\Users\dev`,
          APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
          LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
        }
      }).split(";")
    ).toEqual(
      expect.arrayContaining([
        String.raw`C:\Windows\System32`,
        String.raw`C:\Users\dev\AppData\Roaming\npm`,
        String.raw`C:\Users\dev\AppData\Local\pnpm`,
        String.raw`C:\Users\dev\.local\bin`,
        String.raw`C:\Users\dev\.grok\bin`
      ])
    );
  });

  it("uses Windows delimiters and keeps existing Path entries first", () => {
    expect(
      agentProcessPath({
        envPath: String.raw`C:\Tools;C:\Users\dev\AppData\Roaming\npm`,
        platform: "win32",
        env: {
          USERPROFILE: String.raw`C:\Users\dev`,
          APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
          LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
        }
      }).split(";")
    ).toEqual(
      expect.arrayContaining([
        String.raw`C:\Tools`,
        String.raw`C:\Users\dev\AppData\Roaming\npm`,
        String.raw`C:\Users\dev\AppData\Local\pnpm`
      ])
    );
  });

  it("collapses Path/PATH on Windows while keeping user install fallbacks", () => {
    const env = agentProcessEnv({
      platform: "win32",
      env: {
        Path: String.raw`C:\Tools`,
        PATH: "should-not-survive",
        USERPROFILE: String.raw`C:\Users\dev`,
        APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
        LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
      }
    });
    expect(env.Path?.split(";")[0]).toBe(String.raw`C:\Tools`);
    expect(env.Path?.split(";")).toEqual(
      expect.arrayContaining([String.raw`C:\Users\dev\AppData\Roaming\npm`])
    );
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

  it("materializes only POSIX platform basics and explicitly requested variables", () => {
    const ambient = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/example",
      TMP: "/tmp",
      CUSTOM_API_KEY: "local-secret",
      AWS_SECRET_ACCESS_KEY: "must-not-leak"
    };
    const resolved = resolveAgentProcessEnvironment({
      platform: "darwin",
      ambient,
      shellOverlay: {
        PATH: "/Users/example/.nvm/bin",
        OPTIONAL_VALUE: "from-shell",
        GITHUB_TOKEN: "must-not-leak"
      },
      contract: {
        variables: [
          { name: "CUSTOM_API_KEY", required: true },
          { name: "OPTIONAL_VALUE", required: false }
        ]
      }
    });

    expect(resolved.env.PATH.split(":").slice(0, 3)).toEqual([
      "/Users/example/.nvm/bin",
      "/usr/bin",
      "/bin"
    ]);
    expect(resolved.env).toMatchObject({
      HOME: "/Users/example",
      TMP: "/tmp",
      CUSTOM_API_KEY: "local-secret",
      OPTIONAL_VALUE: "from-shell"
    });
    expect(resolved.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(resolved.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(ambient).toEqual(expect.objectContaining({ AWS_SECRET_ACCESS_KEY: "must-not-leak" }));
    expect(resolved.availableNames).toEqual(Object.keys(resolved.env));
  });

  it("keeps empty strings present and reports required missing names without values", () => {
    expect(
      resolveAgentProcessEnvironment({
        platform: "linux",
        ambient: { PATH: "/bin", EMPTY_CREDENTIAL: "" },
        contract: { variables: [{ name: "EMPTY_CREDENTIAL", required: true }] }
      }).env.EMPTY_CREDENTIAL
    ).toBe("");

    expect(() =>
      resolveAgentProcessEnvironment({
        platform: "linux",
        ambient: { PATH: "/bin", UNDECLARED_SECRET: "secret-marker" },
        contract: { variables: [{ name: "REQUIRED_TOKEN", required: true }] }
      })
    ).toThrow(AgentEnvironmentMissingError);
    try {
      resolveAgentProcessEnvironment({
        platform: "linux",
        ambient: { PATH: "/bin", UNDECLARED_SECRET: "secret-marker" },
        contract: { variables: [{ name: "REQUIRED_TOKEN", required: true }] }
      });
    } catch (error) {
      expect(error).toMatchObject({ missingNames: ["REQUIRED_TOKEN"] });
      expect(String(error)).not.toContain("secret-marker");
    }
  });

  it("normalizes Windows Path and includes only required platform launch variables", () => {
    const resolved = resolveAgentProcessEnvironment({
      platform: "win32",
      ambient: {
        PATH: String.raw`C:\Windows\System32`,
        PATHEXT: ".CMD;.EXE",
        SYSTEMROOT: String.raw`C:\Windows`,
        COMSPEC: String.raw`C:\Windows\System32\cmd.exe`,
        USERPROFILE: String.raw`C:\Users\dev`,
        APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
        LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`,
        safe_api_key: "case-insensitive-value",
        PRIVATE_TOKEN: "must-not-leak"
      },
      contract: { variables: [{ name: "SAFE_API_KEY", required: true }] }
    });

    expect(resolved.env.Path).toContain(String.raw`C:\Windows\System32`);
    expect(resolved.env).not.toHaveProperty("PATH");
    expect(resolved.env).toMatchObject({
      PATHEXT: ".CMD;.EXE",
      SYSTEMROOT: String.raw`C:\Windows`,
      SAFE_API_KEY: "case-insensitive-value"
    });
    expect(resolved.env).not.toHaveProperty("PRIVATE_TOKEN");
    expect(Object.values(resolved.env)).not.toContain(undefined);
  });

  it("rejects loader and injection variables at the contract boundary", () => {
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "PYTHONPATH",
      "PYTHONHOME",
      "RUBYOPT",
      "RUBYLIB",
      "PERL5OPT",
      "PERL5LIB",
      "JAVA_TOOL_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "DOTNET_STARTUP_HOOKS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "BASH_ENV"
    ]) {
      expect(() =>
        resolveAgentProcessEnvironment({
          platform: "linux",
          ambient: { PATH: "/bin", [name]: "injected" },
          contract: { variables: [{ name, required: false }] }
        })
      ).toThrow();
    }
  });
});
