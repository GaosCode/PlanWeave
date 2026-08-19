import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE,
  PLANWEAVE_COMPOSE_CONTAINER_CONFIG,
  PLANWEAVE_COMPOSE_FILE,
  PLANWEAVE_COMPOSE_INNER_BIN,
  PLANWEAVE_COMPOSE_SERVICE,
  composeRestoreRunArgs,
  composeStopArgs,
  composeUpArgs,
  restoreServerDataScript,
  restoreServerDataViaCompose
} from "../serverDataCompose.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("server data compose restore", () => {
  it("keeps the packed restore script aligned with the docker compose argv", () => {
    expect(restoreServerDataScript).toContain(`-f "$COMPOSE_DIR/${PLANWEAVE_COMPOSE_FILE}"`);
    expect(restoreServerDataScript).toContain(
      "run -T --rm --no-deps --user node --entrypoint node"
    );
    expect(restoreServerDataScript).toContain(
      `-v "$ARCHIVE:${PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE}:ro"`
    );
    expect(restoreServerDataScript).toContain(PLANWEAVE_COMPOSE_SERVICE);
    expect(restoreServerDataScript).toContain(`${PLANWEAVE_COMPOSE_INNER_BIN} data restore`);
    expect(restoreServerDataScript).toContain(`--config ${PLANWEAVE_COMPOSE_CONTAINER_CONFIG}`);
    expect(restoreServerDataScript).toContain(`--from ${PLANWEAVE_COMPOSE_CONTAINER_ARCHIVE}`);
    expect(restoreServerDataScript).toContain("up -d --wait");
    expect(
      spawnSync("sh", ["-n", "-c", restoreServerDataScript], { encoding: "utf8" }).status
    ).toBe(0);
  });

  it("stops, restores inside the Server image, then starts compose", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-compose-restore-"));
    directories.push(root);
    await writeFile(join(root, PLANWEAVE_COMPOSE_FILE), "services:\n  server: {}\n");
    await writeFile(join(root, "server.json"), "{}\n");
    const archivePath = join(root, "server-data.tgz");
    await writeFile(archivePath, "archive\n");
    const commands: string[][] = [];
    const manifest = { schemaVersion: "planweave-server-data-archive/v1", fileCount: 2 };
    const restored = await restoreServerDataViaCompose({
      composeDirectory: root,
      archivePath,
      overwrite: true,
      runDockerCompose: async (args) => {
        commands.push([...args]);
        if (args.includes("run")) {
          return { exitCode: 0, stdout: `${JSON.stringify(manifest)}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });
    expect(JSON.parse(restored.manifestJson)).toEqual(manifest);
    expect(commands).toEqual([
      ["compose", ...composeStopArgs(root)],
      [
        "compose",
        ...composeRestoreRunArgs({ composeDirectory: root, archivePath, overwrite: true })
      ],
      ["compose", ...composeUpArgs(root)]
    ]);
    expect(commands[1]).toContain("--overwrite");
    expect(commands[1]).toContain("--user");
    expect(commands[1]).toContain("node");
  });

  it("leaves compose stopped when restore inside the image fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-compose-restore-fail-"));
    directories.push(root);
    await writeFile(join(root, PLANWEAVE_COMPOSE_FILE), "services:\n  server: {}\n");
    await writeFile(join(root, "server.json"), "{}\n");
    const archivePath = join(root, "server-data.tgz");
    await mkdir(join(root, "unused"), { recursive: true });
    await writeFile(archivePath, "archive\n");
    const commands: string[][] = [];
    await expect(
      restoreServerDataViaCompose({
        composeDirectory: root,
        archivePath,
        overwrite: false,
        runDockerCompose: async (args) => {
          commands.push([...args]);
          if (args.includes("run")) {
            return { exitCode: 1, stdout: "", stderr: "server_cli_usage\n" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      })
    ).rejects.toMatchObject({ code: "server_data_restore_image_unsupported" });
    expect(commands.some((command) => command.includes("up"))).toBe(false);
  });
});
