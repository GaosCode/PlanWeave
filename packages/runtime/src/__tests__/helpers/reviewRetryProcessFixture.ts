import { spawn } from "node:child_process";
import type { ProjectWorkspace } from "../../types.js";

const source = new URL("../../", import.meta.url).href;

/** Same stdout/stdin barrier as packageBatchProcessFixture, running current source owners. */
export function spawnReviewRetryActor(
  workspace: ProjectWorkspace,
  holdAfterEdit: boolean,
  operation: "edit" | "retry" | "delete" = "edit"
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import * as fs from 'node:fs/promises';
    const { stat, realpath } = fs;
    import { createHash } from 'node:crypto';
    import { userInfo } from 'node:os';
    import { join } from 'node:path';
    const workspace = JSON.parse(process.argv[1]), source = process.argv[2];
    const { withPackageFileConsistency } = await import(source+'package/packageFileConsistency.ts');
    const { executePlanGraphCommand } = await import(source+'plangraph/executeCommand.ts');
    const key=createHash('sha256').update(await realpath(workspace.packageDir)).digest('hex');
    const lockPath=join(userInfo().homedir,'.cache','planweave','package-locks',key);
    const held=await stat(lockPath).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    if(held) process.stdout.write('waiting\\n');
    const continued = new Promise(resolve=>process.stdin.once('data',resolve));
    const { retryReview } = await import(source+'taskManager/index.ts');
    const edit=()=>process.argv[4]==='retry'
      ? retryReview({projectRoot:workspace,ref:'T-001#R-001',maxFeedbackCycles:3})
      : executePlanGraphCommand({projectRoot:workspace,command:process.argv[4]==='delete'
        ? {type:'removeTask',taskId:'T-002'}
        : {type:'updateTaskFields',taskId:'T-002',fields:{title:'Child edit'}},recordOperation:false});
    if(process.argv[3]==='hold') {
      await withPackageFileConsistency([workspace.packageDir],async()=>{
        const result=await edit(); if('ok' in result && !result.ok)throw new Error(JSON.stringify(result.diagnostics));
        process.stdout.write('edited-held\\n');
        await continued;
      });
    } else {
      const { withAdvisoryDirectoryLock } = await import(source+'fs/advisoryDirectoryLock.ts');
      const { optionalStat } = await import(source+'fs/optionalFile.ts');
      await withAdvisoryDirectoryLock({lockPath,operation:'review-retry-child-edit',fs:{...fs,optionalStat,mkdir:async(path)=>{
        try { await fs.mkdir(path); } catch(error) { if(error.code==='EEXIST')process.stdout.write('contended\\n'); throw error; }
      }}},async()=>{
        const result=await edit(); if('ok' in result && !result.ok)throw new Error(JSON.stringify(result.diagnostics));
      });
      process.stdout.write('edited\\n');
    }
    process.stdin.destroy();
  `,
      JSON.stringify(workspace),
      source,
      holdAfterEdit ? "hold" : "edit",
      operation
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderr = "";
  let observedHeld = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimeout = setTimeout(
    () => readyReject(new Error("Review retry actor barrier timed out.")),
    10_000
  );
  readyTimeout.unref();
  void ready.finally(() => clearTimeout(readyTimeout)).catch(() => undefined);
  child.stderr.on("data", (value) => {
    stderr += String(value);
  });
  child.stdout.on("data", (value) => {
    const lines = String(value).trim().split("\n");
    if (lines.includes("contended")) {
      observedHeld = true;
      readyResolve();
    }
    if (lines.includes("edited-held") || lines.includes("edited")) readyResolve();
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", (error) => {
      readyReject(error);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) readyReject(new Error(stderr));
      resolve({ code, stderr });
    });
  });
  void ready.catch(() => undefined);
  void done.catch(() => undefined);
  return {
    child,
    ready,
    done,
    get observedHeld() {
      return observedHeld;
    }
  };
}
