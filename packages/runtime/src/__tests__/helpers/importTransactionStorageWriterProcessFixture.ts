import { spawn } from "node:child_process";
import type { ProjectWorkspace } from "../../types.js";

/** Observe the native writer's prepared lease publication, without acquiring a fixture lock. */
export function spawnImportStorageWriter(
  workspace: ProjectWorkspace,
  kind: "state" | "results",
  holdBeforePublish = false
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const publish = fs.rename;
    fs.rename = async (...args) => {
      try { return await publish(...args); }
      catch(error) {
        if(['EEXIST','ENOTEMPTY','EPERM','EBUSY','ENOTDIR'].includes(error.code) &&
          String(args[0]).startsWith(String(args[1])+'.prepare-') &&
          String(args[1]).split(/[\\\\/]/).some(part=>part==='package-locks'||part==='import-transaction-locks')) process.stdout.write('contended\\n');
        throw error;
      }
    };
    syncBuiltinESMExports();
    const workspace=JSON.parse(process.argv[1]), source=process.argv[2];
    if(process.argv[4]==='hold') {
      const rename = fs.rename;
      const canonicalState = await fs.realpath(workspace.stateFile);
      fs.rename = async (...args) => {
        if(String(args[1])===workspace.stateFile || String(args[1])===canonicalState) {
          process.stdout.write('writing\\n');
          await new Promise(() => setInterval(() => {}, 1000));
        }
        return rename(...args);
      };
      syncBuiltinESMExports();
    }

    if(process.argv[3]==='state') {
      const {createEmptyState,writeState}=await import(source+'state.ts');
      await writeState(workspace.stateFile,{...createEmptyState(),currentRefs:['T-001#B-001']});
    } else {
      const {updateTaskIndex}=await import(source+'taskManager/resultIndex.ts');
      await updateTaskIndex(workspace,'T-001',index=>({...index,counts:{...index.counts,runs:2}}));
    }
    process.stdout.write('saved\\n');
  `,
      JSON.stringify(workspace),
      new URL("../../", import.meta.url).href,
      kind,
      holdBeforePublish ? "hold" : "normal"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let observedContention = false;
  let stderr = "";
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    rejectReady = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
  });
  const timeout = setTimeout(
    () => rejectReady(new Error("Import storage writer barrier timed out.")),
    10_000
  );
  timeout.unref();
  child.stdout.on("data", (value) => {
    const output = String(value);
    if (output.includes("contended\n")) {
      observedContention = true;
      if (!holdBeforePublish) resolveReady();
    }
    if (output.includes("writing\n") || output.includes("saved\n")) resolveReady();
  });
  child.stderr.on("data", (value) => {
    stderr += String(value);
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once("close", (code) => {
      if (code !== 0) rejectReady(new Error(stderr));
      resolve({ code, stderr });
    });
  });
  const settled = Promise.allSettled([ready, done]);
  return {
    child,
    ready,
    done,
    settled,
    get observedContention() {
      return observedContention;
    }
  };
}
