import * as fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as json from "../json.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { createEmptyState, readState, writeState } from "../state.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>())
}));

afterEach(() => vi.restoreAllMocks());

it.each([
  false,
  true
])("releases a failed reader receipt before the next import (writeFails=%s)", async (writeFails) => {
  const fixture = await createTestWorkspace();
  const workspace = fixture.init.workspace;
  const before = await fs.readFile(workspace.stateFile, "utf8");
  const releaseError = Object.assign(new Error("reader release EIO"), { code: "EIO" });
  const writeError = new Error("state publication failed");
  const actualRm = fs.rm;
  const actualWrite = json.writeJsonFile;
  let receipt = "";
  let failed = false;
  vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (!failed && String(path).includes(".readers/") && String(path).endsWith(".json")) {
      failed = true;
      receipt = String(path);
      throw releaseError;
    }
    return actualRm(path, options);
  });
  if (writeFails) {
    vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value) => {
      if (path === workspace.stateFile) throw writeError;
      return actualWrite(path, value);
    });
  }
  try {
    const write = writeState(workspace.stateFile, createEmptyState());
    if (writeFails) {
      await expect(write).rejects.toMatchObject({ errors: [writeError, releaseError] });
      expect(await fs.readFile(workspace.stateFile, "utf8")).toBe(before);
    } else {
      await expect(write).rejects.toBe(releaseError);
      expect(await readState(workspace.stateFile)).toEqual(createEmptyState());
    }
    expect(receipt).not.toBe("");
    await expect(fs.access(receipt)).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    const transaction = await ImportTransaction.create({ workspaceRoot: workspace.workspaceRoot });
    await transaction.commit();
  } finally {
    vi.restoreAllMocks();
    if (receipt) await actualRm(receipt, { force: true });
  }
});

it("preserves diagnostics and the receipt when both cleanup attempts fail", async () => {
  const fixture = await createTestWorkspace();
  const errors = [
    new Error("first receipt release failed"),
    new Error("second receipt release failed")
  ];
  const actualRm = fs.rm;
  let receipt = "";
  let attempts = 0;
  vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (!receipt && String(path).includes(".readers/") && String(path).endsWith(".json")) {
      receipt = String(path);
    }
    if (String(path) === receipt) throw errors[attempts++];
    return actualRm(path, options);
  });
  try {
    await expect(
      writeState(fixture.init.workspace.stateFile, createEmptyState())
    ).rejects.toMatchObject({
      errors
    });
    expect(attempts).toBe(2);
    expect(JSON.parse(await fs.readFile(receipt, "utf8"))).toEqual({ pid: process.pid });
  } finally {
    vi.restoreAllMocks();
    if (receipt) await actualRm(receipt, { force: true });
  }
});
