import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerConfig, parseServerConfig, serverConfigFileInput } from "../config.js";
import { prepareContainerRuntime } from "../containerPrepare.js";
import { hashOperatorToken } from "../operatorAuth.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave-server-container-prepare-"));
  directories.push(root);
  const { uid, gid } = await lstat(root);
  const owner = { uid, gid };
  const inputTlsDirectory = join(root, "input-tls");
  const runtimeDirectory = join(root, "runtime");
  const stateDirectory = join(root, "state");
  const configPath = join(root, "server.json");
  await mkdir(inputTlsDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(inputTlsDirectory, "server.crt"), "certificate"),
    writeFile(join(inputTlsDirectory, "server.key"), "private-key")
  ]);
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "0.0.0.0", port: 443 },
    publicUrl: "https://server.example.test",
    deployment: {
      topology: "public_https",
      serverOrigin: "https://server.example.test/",
      allowedClientOrigins: ["https://desktop.example.test/"],
      tlsTrust: "configured_ca"
    },
    tls: {
      certificatePath: join(inputTlsDirectory, "server.crt"),
      privateKeyPath: join(inputTlsDirectory, "server.key")
    },
    dataDirectory: stateDirectory,
    trustedProjects: [
      {
        workspaceId: "workspace-test",
        projectId: "project-test",
        canvasId: "default",
        projectRoot: root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"C".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const configInput = serverConfigFileInput(config);
  await writeFile(configPath, `${JSON.stringify(configInput)}\n`);
  return { configPath, inputTlsDirectory, runtimeDirectory, stateDirectory, owner };
}

describe("container runtime preparation", () => {
  it("copies TLS into private runtime storage and rewrites only validated config paths", async () => {
    const input = await fixture();
    await prepareContainerRuntime({
      inputConfigPath: input.configPath,
      inputTlsDirectory: input.inputTlsDirectory,
      runtimeDirectory: input.runtimeDirectory,
      stateDirectory: input.stateDirectory,
      owner: input.owner
    });
    const runtimeConfig = JSON.parse(
      await readFile(join(input.runtimeDirectory, "server.json"), "utf8")
    );
    expect(runtimeConfig.transport.listener.tls).toEqual({
      certificatePath: join(input.runtimeDirectory, "tls/server.crt"),
      privateKeyPath: join(input.runtimeDirectory, "tls/server.key")
    });
    await expect(
      loadServerConfig(join(input.runtimeDirectory, "server.json"))
    ).resolves.toMatchObject({
      dataDirectory: input.stateDirectory,
      databasePath: join(input.stateDirectory, "planweave-server.sqlite")
    });
    await expect(readFile(join(input.runtimeDirectory, "tls/server.key"), "utf8")).resolves.toBe(
      "private-key"
    );
  });

  it("refuses to overwrite an existing runtime directory", async () => {
    const input = await fixture();
    await mkdir(input.runtimeDirectory, { recursive: true });
    await writeFile(join(input.runtimeDirectory, "existing"), "do-not-overwrite");

    await expect(
      prepareContainerRuntime({
        inputConfigPath: input.configPath,
        inputTlsDirectory: input.inputTlsDirectory,
        runtimeDirectory: input.runtimeDirectory,
        stateDirectory: input.stateDirectory,
        owner: input.owner
      })
    ).rejects.toThrow("server_container_runtime_directory_invalid");
    await expect(readFile(join(input.runtimeDirectory, "existing"), "utf8")).resolves.toBe(
      "do-not-overwrite"
    );
  });
});
