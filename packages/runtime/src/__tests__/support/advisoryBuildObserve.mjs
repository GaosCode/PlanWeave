import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.promises.rename;
let sent = false;
fs.promises.rename = async (from, to) => {
  try {
    return await original(from, to);
  } catch (error) {
    if (
      !sent &&
      String(to).endsWith(".planweave-workspace-consumer-build.lock") &&
      ["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY"].includes(error.code)
    ) {
      sent = true;
      process.send({ event: "contended", actor: process.env.TEST_BUILD_ACTOR, pid: process.pid });
    }
    throw error;
  }
};
syncBuiltinESMExports();
