import { afterEach, describe, expect, it } from "vitest";
import {
  commandFingerprint,
  isCommandTrusted,
  listTrustedCommands,
  trustCommand,
  trustedCommandsPath,
  trustedCommandsSchema
} from "../taskManager/hookTrustStore.js";
import { readJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("hookTrustStore", () => {
  it("trusts a command fingerprint and rejects different args", async () => {
    const { root, init } = await createTestWorkspace();
    const command = process.execPath;
    const args = ["-e", "process.exit(0)"];

    expect(await isCommandTrusted(root, command, args)).toBe(false);
    const entry = await trustCommand(root, command, args);
    expect(entry.id).toBe(commandFingerprint(command, args));
    expect(await isCommandTrusted(root, command, args)).toBe(true);
    expect(await isCommandTrusted(root, command, ["-e", "process.exit(1)"])).toBe(false);
    expect(await listTrustedCommands(root)).toEqual([entry]);

    const onDisk = await readJsonFile(trustedCommandsPath(init.workspace));
    expect(trustedCommandsSchema.parse(onDisk)).toMatchObject({
      version: "hook-trust/v1",
      entries: [{ command, args }]
    });
  });

  it("keeps commandFingerprint stable for the same command and args", () => {
    expect(commandFingerprint("node", ["a", "b"])).toBe(commandFingerprint("node", ["a", "b"]));
    expect(commandFingerprint("node", ["a", "b"])).not.toBe(commandFingerprint("node", ["b", "a"]));
  });
});
