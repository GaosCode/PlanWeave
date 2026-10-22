import * as fs from "node:fs/promises";

const [moduleUrl, lockPath, mode = "held"] = process.argv.slice(2);
const { withAdvisoryDirectoryLock } = await import(moduleUrl);
process.on("message", () => process.exit(0));
const adapter = {
  ...fs,
  optionalStat: async (path) => {
    try {
      return await fs.stat(path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  writeFile: async (path, data, encoding) => {
    if (mode !== "held" && path.endsWith("holder.json")) {
      if (mode === "partial") await fs.writeFile(path, "{", encoding);
      process.send({ event: "publishing", pid: process.pid });
      await new Promise(() => {});
    }
    await fs.writeFile(path, data, encoding);
  }
};
await withAdvisoryDirectoryLock({ lockPath, operation: "child-owner", fs: adapter }, async () => {
  process.send({ event: "held", pid: process.pid });
  await new Promise(() => {});
});
