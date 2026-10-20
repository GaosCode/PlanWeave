import { spawn } from "node:child_process";

type ImportOutcome = { ok: true } | { ok: false; message: string };

/** Pause native project admission after the worker's real staging and preflight. */
export function spawnManagedImport(options: {
  moduleUrl: string;
  home: string;
  name: string;
  files: readonly { path: string; content: string; encoding: "utf8" | "base64" }[];
}) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      import {join} from 'node:path';
      import {userInfo} from 'node:os';
      const options=JSON.parse(process.argv[1]);
      const mkdir=fs.mkdir;
      let paused=false;
      fs.mkdir=async (...args)=>{
        const result=await mkdir(...args);
        if(!paused && args[0]===join(userInfo().homedir,'.cache','planweave','project-locks')) {
          paused=true;
          const resumed=new Promise(resolve=>process.once('message',resolve));
          process.send({type:'ready'});
          await resumed;
        }
        return result;
      };
      syncBuiltinESMExports();
      const {importPackageFiles}=await import(options.moduleUrl);
      try {
        await importPackageFiles(options.name,options.files,false);
        process.send({type:'result',outcome:{ok:true}});
      } catch(error) {
        process.send({type:'result',outcome:{ok:false,message:error.message}});
      }
      process.disconnect();
      `,
      JSON.stringify(options)
    ],
    {
      env: { ...process.env, PLANWEAVE_HOME: options.home },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    }
  );
  let stderr = "";
  let reachedAdmission = false;
  let receivedOutcome = false;
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let readyResolve!: () => void;
  let outcomeResolve!: (result: ImportOutcome) => void;
  let rejectWaiting!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectWaiting = reject;
  });
  const ready = Promise.race([
    new Promise<void>((resolve) => {
      readyResolve = resolve;
    }),
    failed
  ]);
  const outcome = Promise.race([
    new Promise<ImportOutcome>((resolve) => {
      outcomeResolve = resolve;
    }),
    failed
  ]);
  child.on("message", (message) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "ready") {
      reachedAdmission = true;
      readyResolve();
    }
    if (message.type === "result" && "outcome" in message) {
      receivedOutcome = true;
      if (!reachedAdmission) {
        rejectWaiting(
          new Error(`Import exited before project admission: ${JSON.stringify(message.outcome)}`)
        );
      }
      outcomeResolve(message.outcome as ImportOutcome);
    }
  });
  const deadline = setTimeout(() => {
    rejectWaiting(new Error(`Managed import worker timed out: ${stderr}`));
    child.kill("SIGKILL");
  }, 8_000);
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      clearTimeout(deadline);
      rejectWaiting(error);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      if (code !== 0 || !receivedOutcome)
        rejectWaiting(new Error(`Managed import worker exited ${code}: ${stderr}`));
      resolve(code);
    });
  });
  void ready.catch(() => undefined);
  void outcome.catch(() => undefined);
  return {
    ready,
    outcome,
    exited,
    resume: () => child.send("admit"),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  };
}
