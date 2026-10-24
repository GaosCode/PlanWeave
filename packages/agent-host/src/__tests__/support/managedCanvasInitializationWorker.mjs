import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

let release;
let started = false;
process.on("message", async (message) => {
  if (message.type === "release") {
    release?.();
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  const link = fs.link.bind(fs);
  const rename = fs.rename.bind(fs);
  fs.link = async (from, to) => {
    if (basename(to) === message.pauseAt) {
      await new Promise((resolve) => {
        release = resolve;
        process.send?.({ type: "paused", from, to });
      });
    }
    return link(from, to);
  };
  fs.rename = async (...args) => {
    try {
      return await rename(...args);
    } catch (error) {
      if (
        ["EEXIST", "ENOTEMPTY", "EPERM", "EBUSY", "ENOTDIR"].includes(error?.code) &&
        String(args[0]).startsWith(`${args[1]}.prepare-`) &&
        String(args[1]).split(/[\\/]/).includes("project-locks")
      ) {
        process.send?.({ type: "contended", path: String(args[1]) });
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  try {
    const { ConfiguredCanvasRuntimeResolver } = await import(
      "../../runtime/canvasRuntimeResolver.ts"
    );
    const result = await new ConfiguredCanvasRuntimeResolver(message.config).resolve(message.scope);
    process.send?.({ type: "resolved", result }, () => process.disconnect());
  } catch (error) {
    process.send?.({ type: "failed", error: String(error), stack: error?.stack }, () =>
      process.disconnect()
    );
    process.exitCode = 1;
  }
});
process.send?.({ type: "ready" });
