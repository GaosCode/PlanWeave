import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./support/cliTestHarness.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planweave-cli-download-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function cli(mode: "timeout" | "limit" | "success") {
  const preload = join(root, `fetch-${mode}.mjs`);
  await writeFile(
    preload,
    `
    import { createRequire } from 'node:module';
    import { createHash } from 'node:crypto';
    const mode = ${JSON.stringify(mode)};
    if (mode === 'timeout') {
      const native = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => native(fn, ms === 120000 ? 10 : ms, ...args);
      globalThis.fetch = () => new Promise(() => {});
    } else if (mode === 'limit') {
      globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
    } else {
      const require = createRequire(${JSON.stringify(join(repoRoot, "packages/mcp/package.json"))});
      const { zipSync } = require('fflate');
      const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
      const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
      const name = 'tunnel-client-v-test-' + os + '-' + arch + '.zip';
      const bytes = zipSync({ [process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client']: Buffer.from('cli fixture binary') });
      const hash = createHash('sha256').update(bytes).digest('hex');
      globalThis.fetch = async (url) => String(url).endsWith('/latest') ? Response.json({ tag_name: 'v-test', assets: [
        { name, browser_download_url: 'https://fixture.test/client.zip' },
        { name: 'SHA256SUMS.txt', browser_download_url: 'https://fixture.test/checksum' }
      ] }) : String(url).endsWith('/checksum') ? new Response(hash + '  ' + name) : new Response(bytes);
    }
  `
  );
  return runCli(
    ["mcp", "tunnel", "download"],
    {
      ...process.env,
      PLANWEAVE_HOME: root,
      PLANWEAVE_DEBUG: "0",
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`
    },
    { hardTimeoutMs: 8_000 }
  );
}

describe("CLI tunnel download failures", () => {
  it.each([
    "timeout",
    "limit"
  ] as const)("exits nonzero with a diagnostic for %s and supports a fresh successful invocation", async (mode) => {
    await expect(cli(mode)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(mode === "timeout" ? "operation deadline" : "byte limit")
    });
    const result = await cli("success");
    expect(result.stdout).toContain("downloaded tunnel-client:");
    const config = JSON.parse(
      await readFile(join(root, "config/mcp-tunnel/config.json"), "utf8")
    ) as {
      tunnelClientPath: string;
      verification: { binarySha256: string };
    };
    const binary = await readFile(config.tunnelClientPath);
    expect(binary.toString()).toBe("cli fixture binary");
    expect(config.verification.binarySha256).toBe(
      createHash("sha256").update(binary).digest("hex")
    );
  }, 20_000);
});
