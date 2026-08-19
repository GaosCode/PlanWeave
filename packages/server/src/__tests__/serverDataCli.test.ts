import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runServerCli } from "../bin.js";
import { parseServerConfig, serverConfigFileInput } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { openServerDatabase } from "../sqlite.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave-server-data-cli-"));
  directories.push(root);
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const database = await openServerDatabase(join(dataDirectory, "planweave-server.sqlite"), 1_000);
  database.close();
  const config = parseServerConfig({
    version: "server-config/v2",
    transport: {
      mode: "loopback_http",
      listener: { protocol: "http", host: "127.0.0.1", port: 8787 },
      advertisedOrigin: "http://127.0.0.1:8787/"
    },
    deployment: {
      topology: "loopback_http",
      serverOrigin: "http://127.0.0.1:8787/",
      allowedClientOrigins: ["http://127.0.0.1:8787/"],
      tlsTrust: "not_applicable"
    },
    allowedClientOrigins: null,
    dataDirectory,
    trustedProjects: [],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"D".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const configPath = join(root, "server.json");
  await writeFile(configPath, `${JSON.stringify(serverConfigFileInput(config), null, 2)}\n`);
  return { root, configPath, dataDirectory };
}

describe("planweave-server data CLI", () => {
  it("exports and restores a Server data archive", async () => {
    const { root, configPath, dataDirectory } = await fixture();
    const archivePath = join(root, "server-data.tgz");
    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(
      runServerCli(["data", "export", "--config", configPath, "--out", archivePath], {
        io: { stdout, stderr }
      })
    ).resolves.toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      schemaVersion: "planweave-server-data-archive/v1"
    });
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0])).fileCount).toBeGreaterThanOrEqual(1);

    const restoredConfigPath = join(root, "restored-server.json");
    const restoredData = join(root, "restored");
    const restoredConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      dataDirectory: string;
    };
    restoredConfig.dataDirectory = restoredData;
    await writeFile(restoredConfigPath, `${JSON.stringify(restoredConfig, null, 2)}\n`);

    stdout.mockClear();
    await expect(
      runServerCli(["data", "restore", "--config", restoredConfigPath, "--from", archivePath], {
        io: { stdout, stderr }
      })
    ).resolves.toBe(0);
    const restoredDatabase = await openServerDatabase(
      join(restoredData, "planweave-server.sqlite"),
      1_000
    );
    restoredDatabase.close();
    const sourceDatabase = await openServerDatabase(
      join(dataDirectory, "planweave-server.sqlite"),
      1_000
    );
    sourceDatabase.close();

    stdout.mockClear();
    await expect(
      runServerCli(["data", "restore", "--config", restoredConfigPath, "--from", archivePath], {
        io: { stdout, stderr }
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("server_data_directory_nonempty");
  });

  it("prints usage for an incomplete data command", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runServerCli(["data", "export"], { io: { stdout, stderr } })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith("server_config_path_required");
  });

  it("requires a compose directory or config path to restore", async () => {
    const { root } = await fixture();
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(
      runServerCli(["data", "restore", "--from", join(root, "missing.tgz")], {
        io: { stdout, stderr },
        cwd: root
      })
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith("server_compose_or_config_required");
  });

  it("restores through docker compose when the cwd is a self-host bundle", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "compose.yaml"), "services:\n  server: {}\n");
    const archivePath = join(root, "server-data.tgz");
    await writeFile(archivePath, "archive\n");
    const stdout = vi.fn();
    const stderr = vi.fn();
    const commands: string[][] = [];
    await expect(
      runServerCli(["data", "restore", "--from", archivePath, "--overwrite"], {
        io: { stdout, stderr },
        cwd: root,
        runDockerCompose: async (args) => {
          commands.push([...args]);
          if (args.includes("run")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                schemaVersion: "planweave-server-data-archive/v1",
                fileCount: 1
              }),
              stderr: ""
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      })
    ).resolves.toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      schemaVersion: "planweave-server-data-archive/v1"
    });
    expect(commands).toHaveLength(3);
    expect(commands[0]?.slice(-1)).toEqual(["stop"]);
    expect(commands[1]).toContain("run");
    expect(commands[2]).toEqual(expect.arrayContaining(["up", "-d", "--wait"]));
  });
});
