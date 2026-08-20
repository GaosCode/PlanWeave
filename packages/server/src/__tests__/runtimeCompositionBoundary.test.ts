import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const transportSource = readFileSync(
  fileURLToPath(new URL("../composition/transport.ts", import.meta.url)),
  "utf8"
);
const compositionRootSource = readFileSync(
  fileURLToPath(new URL("../serverComposition.ts", import.meta.url)),
  "utf8"
);
const removedStatusSurfaceSources = [
  "../canvas/runtimePort.ts",
  "../canvas/localFilesystemRuntimeAdapter.ts",
  "../canvas/service.ts",
  "../canvas/http.ts",
  "../canvas/collaborationComposition.ts",
  "../canvas/index.ts",
  "../composition/transport.ts",
  "../serverComposition.ts",
  "../index.ts"
]
  .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"))
  .join("\n");

describe("Runtime composition boundary", () => {
  it("keeps transport limited to logical Runtime attachments", () => {
    expect(transportSource).toContain("runtimeAttachments: readonly CanvasRuntimeAttachment[]");
    expect(transportSource).not.toContain("TrustedRuntimeRegistry");
    expect(transportSource).not.toContain("runtimeRegistry:");
    expect(transportSource).toContain("runtimeAvailability: CanvasRuntimeAvailabilityPort");
    expect(transportSource).not.toContain("CanvasRuntimeStatusPort");
    expect(transportSource).not.toContain("runtimeStatus:");
    expect(compositionRootSource).toContain(
      "runtimeAttachments: registries.runtimeRegistry.locators"
    );
    expect(compositionRootSource).toContain("runtimeAvailability: collaborationRuntime");
    expect(compositionRootSource).toContain(
      "const collaborationRuntime = new LocalFirstCanvasRuntimeRouter("
    );
    expect(compositionRootSource).not.toContain("runtimeStatus: localCanvasRuntime");
  });

  it("has no Server API or wiring for the removed Runtime Status surface", () => {
    expect(removedStatusSurfaceSources).not.toContain("CanvasRuntimeStatusPort");
    expect(removedStatusSurfaceSources).not.toContain("readRuntimeStatus");
    expect(removedStatusSurfaceSources).not.toContain("runtime-status");
    expect(removedStatusSurfaceSources).not.toContain("runtimeStatus:");
  });
});
