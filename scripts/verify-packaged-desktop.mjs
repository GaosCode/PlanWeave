import { spawnSync } from "node:child_process";

const platform = { darwin: "mac", win32: "win", linux: "linux" }[process.platform];
if (!platform) throw new Error(`Unsupported packaged verification platform: ${process.platform}`);
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("Run packaged verification through pnpm.");
const commands =
  platform === "mac"
    ? [["--dir", "packages/desktop", "verify:packaged:mac"]]
    : [
        ["--dir", "packages/desktop", `pack:${platform}`],
        ["--dir", "packages/desktop", "exec", "node", "scripts/verify-packaged-app.mjs"]
      ];
for (const args of commands) {
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.signal) console.error(`Packaged verification terminated by ${result.signal}`);
    process.exit(result.status ?? 1);
  }
}
