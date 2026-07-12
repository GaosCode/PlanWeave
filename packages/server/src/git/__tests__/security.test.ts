import { describe, expect, it } from "vitest";
import { validatePathWithinScope } from "../validation.js";

describe("merge queue path scope security", () => {
  it("accepts exact files and descendants of wildcard directories", () => {
    expect(() => validatePathWithinScope(
      ["packages/server/src/events/index.ts", "README.md"],
      ["packages/server/src/events/**", "README.md"]
    )).not.toThrow();
  });

  it("does not confuse a path prefix with an owned directory", () => {
    expect(() => validatePathWithinScope(
      ["packages/server/src/events-rogue/payload.ts"],
      ["packages/server/src/events/**"]
    )).toThrowError(/outside the allowed scope/);
  });

  it.each([
    "../secrets.txt",
    "/etc/passwd",
    "packages/server/src/events/../../../secrets.txt",
    "C:\\Windows\\system.ini"
  ])("rejects traversal or absolute changed path %s", (path) => {
    expect(() => validatePathWithinScope([path], ["packages/server/src/events/**"])).toThrowError(/Invalid changed file/);
  });
});
