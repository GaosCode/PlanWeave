import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";

if (process.env.STORE_TEST_FAULT === "cleanup") {
  const remove = fs.rm;
  fs.rm = async (path, options) => {
    if (
      dirname(path) === process.env.TMPDIR &&
      basename(path).startsWith("planweave-deploy-store-")
    ) {
      throw Object.assign(new Error("owned store cleanup EACCES"), { code: "EACCES" });
    }
    return remove(path, options);
  };
}
if (process.env.STORE_TEST_FAULT === "spawn") {
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) =>
    spawn(
      args.includes("deploy")
        ? join(process.env.STORE_TEST_ROOT, "missing-deploy-executable")
        : command,
      args,
      options
    );
}
syncBuiltinESMExports();
