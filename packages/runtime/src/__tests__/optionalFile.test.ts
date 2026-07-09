import { describe, expect, it, beforeEach, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
}));

vi.mock("node:fs/promises", () => fsMock);

import {
  isNodeFileNotFoundError,
  optionalReadFile,
  optionalReaddir,
  optionalStat
} from "../fs/optionalFile.js";

function nodeFileError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code} failure`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("optional file helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("recognizes only missing path errors as optional file absence", () => {
    expect(isNodeFileNotFoundError(nodeFileError("ENOENT"))).toBe(true);
    expect(isNodeFileNotFoundError(nodeFileError("ENOTDIR"))).toBe(true);
    expect(isNodeFileNotFoundError(nodeFileError("EACCES"))).toBe(false);
    expect(isNodeFileNotFoundError(new Error("plain failure"))).toBe(false);
  });

  it("returns null for ENOENT and ENOTDIR", async () => {
    fsMock.stat.mockRejectedValueOnce(nodeFileError("ENOENT"));
    fsMock.readdir.mockRejectedValueOnce(nodeFileError("ENOTDIR"));
    fsMock.readFile.mockRejectedValueOnce(nodeFileError("ENOENT"));

    await expect(optionalStat("/missing")).resolves.toBeNull();
    await expect(
      optionalReaddir("/not-a-directory/child", { withFileTypes: true })
    ).resolves.toBeNull();
    await expect(optionalReadFile("/missing", "utf8")).resolves.toBeNull();
  });

  it("does not swallow non-missing filesystem errors", async () => {
    const statError = nodeFileError("EACCES");
    const readdirError = nodeFileError("EPERM");
    const readError = nodeFileError("EIO");
    fsMock.stat.mockRejectedValueOnce(statError);
    fsMock.readdir.mockRejectedValueOnce(readdirError);
    fsMock.readFile.mockRejectedValueOnce(readError);

    await expect(optionalStat("/private")).rejects.toBe(statError);
    await expect(optionalReaddir("/private", { withFileTypes: true })).rejects.toBe(readdirError);
    await expect(optionalReadFile("/broken", "utf8")).rejects.toBe(readError);
  });
});
