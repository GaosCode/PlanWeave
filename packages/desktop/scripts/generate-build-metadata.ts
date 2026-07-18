#!/usr/bin/env tsx

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PLANWEAVE_BUILD_METADATA_FILE,
  desktopBuildChannelSchema,
  desktopBuildMetadataSchema,
  desktopBuildVersionSchema,
  type DesktopBuildMetadata
} from "../src/shared/buildMetadata.js";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const defaultOutputPath = resolve(packageRoot, "build", "generated", PLANWEAVE_BUILD_METADATA_FILE);

type GenerateBuildMetadataOptions = {
  channel: DesktopBuildMetadata["channel"];
  signedDistribution: boolean;
  outputPath?: string;
};

export async function generateBuildMetadata(
  options: GenerateBuildMetadataOptions
): Promise<DesktopBuildMetadata> {
  const packageJson: unknown = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8")
  );
  const packageVersion = desktopBuildVersionSchema.parse(
    typeof packageJson === "object" && packageJson !== null && "version" in packageJson
      ? packageJson.version
      : undefined
  );
  const metadata = desktopBuildMetadataSchema.parse({
    signedDistribution: options.signedDistribution,
    channel: options.channel,
    version: packageVersion
  });
  const outputPath = resolve(options.outputPath ?? defaultOutputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
  return metadata;
}

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) {
    throw new Error(`Missing required ${name} option.`);
  }
  return args[index + 1];
}

function parseArguments(args: string[]): GenerateBuildMetadataOptions {
  const supported = new Set(["--channel", "--signed-distribution", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!supported.has(option) || index === args.length - 1) {
      throw new Error(`Unsupported or incomplete build metadata option: ${option ?? "(missing)"}.`);
    }
  }

  const channel = desktopBuildChannelSchema.parse(readOption(args, "--channel"));
  const signedValue = readOption(args, "--signed-distribution");
  if (signedValue !== "true" && signedValue !== "false") {
    throw new Error("--signed-distribution must be true or false.");
  }
  const outputIndex = args.indexOf("--output");
  return {
    channel,
    signedDistribution: signedValue === "true",
    ...(outputIndex >= 0 ? { outputPath: args[outputIndex + 1] } : {})
  };
}

const isDirectRun =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  try {
    const metadata = await generateBuildMetadata(parseArguments(process.argv.slice(2)));
    console.log(
      `Generated ${metadata.channel} desktop build metadata for ${metadata.version} (${metadata.signedDistribution ? "signed" : "unsigned"}).`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
