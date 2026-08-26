import { describe, expect, it } from "vitest";
import {
  WORKSPACE_EXECUTION_PLANE_CLASSIFICATIONS,
  WORKSPACE_EXECUTION_PLANE_INVENTORY,
  WORKSPACE_EXECUTION_PLANE_INVENTORY_IGNORE_PATH_SUBSTRINGS,
  WORKSPACE_EXECUTION_PLANE_TOKENS,
  WORKSPACE_EXECUTION_PLANE_UNKNOWN_ENTRIES
} from "./support/workspaceExecutionPlaneInventory.js";

const scannedSources = import.meta.glob("../../../*/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default"
}) as Record<string, string>;

const classificationSet = new Set<string>(WORKSPACE_EXECUTION_PLANE_CLASSIFICATIONS);

function toRepoPath(globKey: string): string {
  const normalized = globKey.replaceAll("\\", "/");
  const packagesIndex = normalized.lastIndexOf("/packages/");
  if (packagesIndex >= 0) {
    return normalized.slice(packagesIndex + 1);
  }
  const resolved: string[] = ["packages", "server", "src", "__tests__"];
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  if (resolved[0] !== "packages") {
    throw new Error(`unrecognized inventory scan key: ${globKey}`);
  }
  return resolved.join("/");
}

function isIgnored(repoPath: string): boolean {
  if (
    WORKSPACE_EXECUTION_PLANE_INVENTORY_IGNORE_PATH_SUBSTRINGS.some((part) =>
      repoPath.includes(part)
    )
  ) {
    return true;
  }
  return (
    repoPath.includes("/node_modules/") ||
    repoPath.includes("/dist/") ||
    repoPath.includes("/coverage/")
  );
}

describe("workspace execution plane inventory", () => {
  it("classifies every entry and exports an explicit unknown list", () => {
    expect(Array.isArray(WORKSPACE_EXECUTION_PLANE_UNKNOWN_ENTRIES)).toBe(true);
    expect(WORKSPACE_EXECUTION_PLANE_UNKNOWN_ENTRIES).toEqual(
      WORKSPACE_EXECUTION_PLANE_INVENTORY.filter((entry) => entry.classification === "unknown")
    );
    const ids = new Set<string>();
    for (const entry of WORKSPACE_EXECUTION_PLANE_INVENTORY) {
      expect(classificationSet.has(entry.classification)).toBe(true);
      expect(WORKSPACE_EXECUTION_PLANE_TOKENS).toContain(entry.kind);
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.path.startsWith("packages/")).toBe(true);
      expect(entry.symbolOrSql.length).toBeGreaterThan(0);
      expect(entry.notes.length).toBeGreaterThan(0);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      if (entry.classification === "unknown") {
        expect(entry.notes.toLowerCase()).toContain("blocks deletion");
      }
    }
  });

  it("covers every packages/ source match of the five tokens", () => {
    const scannedRepoPaths = Object.keys(scannedSources).map(toRepoPath);
    expect(scannedRepoPaths.some((path) => path.startsWith("packages/desktop/"))).toBe(true);
    expect(
      scannedRepoPaths.some((path) => path.startsWith("packages/collaboration-protocol/"))
    ).toBe(true);
    expect(scannedRepoPaths.some((path) => path.startsWith("packages/agent-host-protocol/"))).toBe(
      true
    );
    const covered = new Set(
      WORKSPACE_EXECUTION_PLANE_INVENTORY.map((entry) => `${entry.kind}\0${entry.path}`)
    );
    const missing: string[] = [];
    for (const [globKey, source] of Object.entries(scannedSources)) {
      const repoPath = toRepoPath(globKey);
      if (isIgnored(repoPath)) continue;
      for (const token of WORKSPACE_EXECUTION_PLANE_TOKENS) {
        if (!source.includes(token)) continue;
        const key = `${token}\0${repoPath}`;
        if (!covered.has(key)) {
          missing.push(`${repoPath} [${token}]`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
