import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertSmokeProcess, waitForSmokeProcess } from "../../scripts/smokeProcessGate.js";

describe("desktop smoke process hard gate", () => {
  it("settles within the hard budget when a process tree ignores SIGTERM and holds stdout", async () => {
    const script = [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});",
      "process.on('SIGTERM',()=>{});",
      "console.log('READY');",
      "setInterval(()=>{},1000);"
    ].join("");
    const child = spawn(process.execPath, ["-e", script], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    await new Promise<void>((resolve) => {
      child.stdout.once("data", () => resolve());
    });
    const started = performance.now();
    const result = await waitForSmokeProcess(child, {
      timeoutMs: 80,
      terminationGraceMs: 80
    });
    expect(result).toMatchObject({ timedOut: true, forceKilled: true });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("scans fatal output emitted immediately before close", async () => {
    const child = new EventEmitter() as ChildProcess;
    let output = "PLANWEAVE_DESKTOP_SMOKE_READY\n";
    const assertion = assertSmokeProcess(child, () => output, {
      timeoutMs: 1_000,
      terminationGraceMs: 50
    });
    output += '{"event":"PLANWEAVE_DESKTOP_RENDERER_GONE","details":{"reason":"late"}}\n';
    child.emit("close", 0);
    await expect(assertion).rejects.toThrow(/fatal renderer failure.*RENDERER_GONE/i);
  });
});
