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

describe("Runtime composition boundary", () => {
  it("keeps transport limited to logical Runtime attachments", () => {
    expect(transportSource).toContain("runtimeAttachments: readonly CanvasRuntimeAttachment[]");
    expect(transportSource).not.toContain("TrustedRuntimeRegistry");
    expect(transportSource).not.toContain("runtimeRegistry:");
    expect(transportSource).toContain("runtimeAvailability: CanvasRuntimeAvailabilityPort");
    expect(compositionRootSource).toContain(
      "runtimeAttachments: registries.runtimeRegistry.locators"
    );
    expect(compositionRootSource).toContain("runtimeAvailability: localCanvasRuntime");
  });
});
