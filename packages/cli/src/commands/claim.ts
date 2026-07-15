import type { Command } from "commander";
import { claimBlock, claimBlockType } from "@planweave-ai/runtime";
import type { BlockType } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

const blockTypes = new Set(["implementation", "review"]);

function parseBlockType(value: string): BlockType | null {
  return blockTypes.has(value) ? (value as BlockType) : null;
}

export function registerClaimCommand(program: Command): void {
  addCanvasOption(
    program
      .command("claim [ref]")
      .description("Claim a specific block by ref, or the next executable block matching a type")
      .option(
        "--type <type>",
        "claim the next executable block of a type: implementation or review"
      )
      .option(
        "--dispatch",
        "formally dispatch a graph-ready implementation block without replacing current work"
      )
  ).action(
    async (
      ref: string | undefined,
      options: { type?: string; dispatch?: boolean } & CanvasCommandOptions
    ) => {
      const projectRoot = await resolveCliPackageWorkspace(options);
      if (ref) {
        console.log(
          JSON.stringify(
            await claimBlock({ projectRoot, ref, dispatch: options.dispatch }),
            null,
            2
          )
        );
        return;
      }
      if (options.dispatch) {
        console.log(
          JSON.stringify(
            { kind: "blocked", reason: "claim --dispatch requires a block ref." },
            null,
            2
          )
        );
        return;
      }
      if (options.type) {
        const blockType = parseBlockType(options.type);
        if (!blockType) {
          console.log(
            JSON.stringify(
              { kind: "blocked", reason: `Unknown block type '${options.type}'.` },
              null,
              2
            )
          );
          return;
        }
        console.log(JSON.stringify(await claimBlockType({ projectRoot, blockType }), null, 2));
        return;
      }
      console.log(
        JSON.stringify(
          { kind: "blocked", reason: "claim requires a block ref or --type." },
          null,
          2
        )
      );
    }
  );
}
