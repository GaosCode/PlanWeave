export const PACKAGED_APP_FILES = [
  "dist/main/**/*",
  "dist/preload/**/*",
  "dist/renderer/**/*",
  "package.json",
  "!**/*.map",
  "!**/node_modules/@planweave-ai/*/release",
  "!**/node_modules/@planweave-ai/*/release/**"
];

export const PACKAGED_RESOURCE_FILTER = [
  "**/*",
  "!**/*.map",
  "!**/node_modules/@planweave-ai/*/release",
  "!**/node_modules/@planweave-ai/*/release/**"
];

const workspaceReleaseEntryPattern = /(?:^|\/)node_modules\/@planweave-ai\/[^/]+\/release(?:\/|$)/;

export function normalizePackagedEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function findForbiddenPackagedEntry(entries) {
  for (const raw of entries) {
    const entry = normalizePackagedEntry(raw);
    if (entry.endsWith(".map")) {
      return { kind: "source-map", entry };
    }
    if (workspaceReleaseEntryPattern.test(entry)) {
      return { kind: "workspace-release", entry };
    }
  }
  return null;
}

export function describeForbiddenPackagedEntry(forbidden, sourceLabel) {
  if (forbidden.kind === "source-map") {
    return `${sourceLabel} contains a source map: ${forbidden.entry}`;
  }
  return `${sourceLabel} contains workspace release artifacts: ${forbidden.entry}`;
}
