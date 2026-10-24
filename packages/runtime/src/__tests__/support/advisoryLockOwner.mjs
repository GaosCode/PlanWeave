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
  lstat: fs.lstat,
  rmdir: fs.rmdir
};
await withAdvisoryDirectoryLock({ lockPath, operation: "child-owner", fs: adapter }, async () => {
  const name = (await fs.readdir(lockPath))[0];
  const holderPath = `${lockPath}/${name}/holder.json`;
  if (mode === "partial") await fs.writeFile(holderPath, "{");
  if (mode === "missing") await fs.unlink(holderPath);
  process.send({ event: mode === "held" ? "held" : "publishing", pid: process.pid });
  await new Promise(() => {});
});
