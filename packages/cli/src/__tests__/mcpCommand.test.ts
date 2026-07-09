import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../index.js";

const previousPlanweaveHome = process.env.PLANWEAVE_HOME;
const previousOpenaiRuntimeApiKey = process.env.OPENAI_RUNTIME_API_KEY;
const previousControlPlaneApiKey = process.env.CONTROL_PLANE_API_KEY;

afterEach(() => {
  if (previousPlanweaveHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = previousPlanweaveHome;
  }
  if (previousOpenaiRuntimeApiKey === undefined) {
    delete process.env.OPENAI_RUNTIME_API_KEY;
  } else {
    process.env.OPENAI_RUNTIME_API_KEY = previousOpenaiRuntimeApiKey;
  }
  if (previousControlPlaneApiKey === undefined) {
    delete process.env.CONTROL_PLANE_API_KEY;
  } else {
    process.env.CONTROL_PLANE_API_KEY = previousControlPlaneApiKey;
  }
});

async function parseCli(args: string[]): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(typeof value === "string" ? value : String(value));
  };
  try {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "planweave-mcp-cli-home-"));
  process.env.PLANWEAVE_HOME = home;
  delete process.env.OPENAI_RUNTIME_API_KEY;
  delete process.env.CONTROL_PLANE_API_KEY;
  return home;
}

describe("planweave mcp command", () => {
  it("configures tunnel id and loopback MCP URL in PLANWEAVE_HOME", async () => {
    const home = await makeHome();
    await parseCli([
      "mcp",
      "tunnel",
      "configure",
      "--tunnel-id",
      " tunnel_test ",
      "--port",
      "9797"
    ]);
    const config = JSON.parse(
      await readFile(join(home, "config", "mcp-tunnel", "config.json"), "utf8")
    ) as {
      tunnelId: string;
      mcpUrl: string;
    };

    expect(config.tunnelId).toBe("tunnel_test");
    expect(config.mcpUrl).toBe("http://127.0.0.1:9797/mcp");
  });

  it("prints status JSON for an empty config without throwing", async () => {
    await makeHome();
    const output = await parseCli(["mcp", "tunnel", "status", "--json"]);
    const status = JSON.parse(output) as {
      configured: boolean;
      binary: { available: boolean };
      runtimeApiKey: { available: boolean; source: string | null };
      config: { mcpUrl: string; tunnelIdConfigured: boolean; tunnelId?: string };
    };

    expect(status.configured).toBe(false);
    expect(status.binary.available).toBe(false);
    expect(status.runtimeApiKey).toEqual({ available: false, source: null });
    expect(status.config.mcpUrl).toBe("http://127.0.0.1:8787/mcp");
    expect(status.config.tunnelIdConfigured).toBe(false);
    expect(status.config).not.toHaveProperty("tunnelId");
  });

  it("redacts tunnel id from machine-readable status and doctor output", async () => {
    await makeHome();
    await parseCli(["mcp", "tunnel", "configure", "--tunnel-id", "tunnel_secret_for_test"]);

    const statusOutput = await parseCli(["mcp", "tunnel", "status", "--json"]);
    const doctorOutput = await parseCli(["mcp", "tunnel", "doctor", "--json"]);
    const status = JSON.parse(statusOutput) as {
      config: { tunnelIdConfigured: boolean; tunnelId?: string };
    };
    const doctor = JSON.parse(doctorOutput) as {
      status: { config: { tunnelIdConfigured: boolean; tunnelId?: string } };
    };

    expect(status.config.tunnelIdConfigured).toBe(true);
    expect(status.config).not.toHaveProperty("tunnelId");
    expect(statusOutput).not.toContain("tunnel_secret_for_test");
    expect(doctor.status.config.tunnelIdConfigured).toBe(true);
    expect(doctor.status.config).not.toHaveProperty("tunnelId");
    expect(doctorOutput).not.toContain("tunnel_secret_for_test");
  });

  it("redacts tunnel id from human status output", async () => {
    await makeHome();
    await parseCli(["mcp", "tunnel", "configure", "--tunnel-id", "tunnel_secret_for_human"]);

    const output = await parseCli(["mcp", "tunnel", "status"]);

    expect(output).toContain("tunnel id: configured");
    expect(output).not.toContain("tunnel_secret_for_human");
  });

  it("rejects a manual binary with the wrong filename", async () => {
    const home = await makeHome();
    const wrongBinary = join(home, "wrong-client");
    await writeFile(wrongBinary, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(wrongBinary, 0o700);

    await expect(parseCli(["mcp", "tunnel", "set-binary", wrongBinary])).rejects.toThrow(
      "Configured binary must be named tunnel-client or tunnel-client.exe."
    );
  });

  it("prints systemd templates without leaking the Runtime API key", async () => {
    await makeHome();
    process.env.OPENAI_RUNTIME_API_KEY = "secret-runtime-key";
    const output = await parseCli([
      "mcp",
      "tunnel",
      "print-systemd",
      "--service-name",
      "planweave-test",
      "--working-directory",
      "/srv/test",
      "--planweave-home",
      "/srv/test",
      "--env-file",
      "/etc/planweave/test.env",
      "--planweave-bin",
      "/usr/bin/planweave"
    ]);

    expect(output).toContain('ExecStart="/usr/bin/planweave" mcp tunnel run --serve');
    expect(output).toContain('EnvironmentFile="/etc/planweave/test.env"');
    expect(output).toContain("OPENAI_RUNTIME_API_KEY=replace-with-openai-runtime-api-key");
    expect(output).not.toContain("secret-runtime-key");
  });
});
