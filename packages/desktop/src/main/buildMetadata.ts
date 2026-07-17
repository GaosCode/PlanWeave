import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PLANWEAVE_BUILD_METADATA_FILE,
  desktopBuildMetadataSchema,
  type DesktopBuildMetadata
} from "../shared/buildMetadata.js";

export function loadDesktopBuildMetadata(
  resourcesPath: string,
  expectedVersion: string
): DesktopBuildMetadata {
  const metadataPath = resolve(resourcesPath, PLANWEAVE_BUILD_METADATA_FILE);
  let source: string;
  try {
    source = readFileSync(metadataPath, "utf8");
  } catch (error) {
    throw new Error(`Desktop build metadata is missing or unreadable at ${metadataPath}.`, {
      cause: error
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Desktop build metadata is not valid JSON at ${metadataPath}.`, {
      cause: error
    });
  }

  const parsed = desktopBuildMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Desktop build metadata failed validation at ${metadataPath}: ${parsed.error.message}`
    );
  }
  if (parsed.data.version !== expectedVersion) {
    throw new Error(
      `Desktop build metadata version ${parsed.data.version} does not match application version ${expectedVersion}.`
    );
  }
  return parsed.data;
}
