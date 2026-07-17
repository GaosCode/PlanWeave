import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDesktopBuildMetadata } from "../main/buildMetadata";
import {
  PLANWEAVE_BUILD_METADATA_FILE,
  desktopBuildMetadataSchema
} from "../shared/buildMetadata";
import { generateBuildMetadata } from "../../scripts/generate-build-metadata";

describe("desktop build metadata", () => {
  it("generates and validates development metadata from the desktop package version", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "planweave-build-metadata-"));
    const outputPath = resolve(directory, PLANWEAVE_BUILD_METADATA_FILE);

    const metadata = await generateBuildMetadata({
      channel: "development",
      signedDistribution: false,
      outputPath
    });

    expect(desktopBuildMetadataSchema.parse(JSON.parse(await readFile(outputPath, "utf8")))).toEqual(
      metadata
    );
    expect(metadata).toMatchObject({
      channel: "development",
      signedDistribution: false,
      version: expect.stringMatching(/^\d+\.\d+\.\d+/)
    });
  });

  it("generates signed release metadata and rejects signed development metadata", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "planweave-signed-build-metadata-"));
    const outputPath = resolve(directory, PLANWEAVE_BUILD_METADATA_FILE);
    const metadata = await generateBuildMetadata({
      channel: "release",
      signedDistribution: true,
      outputPath
    });

    expect(metadata).toMatchObject({
      signedDistribution: true,
      channel: "release"
    });
    expect(loadDesktopBuildMetadata(directory, metadata.version)).toEqual(metadata);
    expect(() =>
      desktopBuildMetadataSchema.parse({
        signedDistribution: true,
        channel: "development",
        version: "1.2.3"
      })
    ).toThrow(/Signed distributions must use the release channel/);
  });

  it("loads the packaged resource and rejects missing, corrupt, or extended metadata", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "planweave-build-resource-"));
    const metadataPath = resolve(directory, PLANWEAVE_BUILD_METADATA_FILE);

    expect(() => loadDesktopBuildMetadata(directory, "1.2.3")).toThrow(/missing or unreadable/);

    await writeFile(metadataPath, "not-json\n");
    expect(() => loadDesktopBuildMetadata(directory, "1.2.3")).toThrow(/not valid JSON/);

    await writeFile(
      metadataPath,
      JSON.stringify({
        signedDistribution: true,
        channel: "release",
        version: "1.2.3",
        secret: "must-not-be-accepted"
      })
    );
    expect(() => loadDesktopBuildMetadata(directory, "1.2.3")).toThrow(/failed validation/);

    await writeFile(
      metadataPath,
      JSON.stringify({ signedDistribution: true, channel: "release", version: "1.2.4" })
    );
    expect(() => loadDesktopBuildMetadata(directory, "1.2.3")).toThrow(
      /does not match application version/
    );
  });
});
