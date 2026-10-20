import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const observationSchema = z.object({
  recoveryDone: z.boolean(),
  startDone: z.boolean(),
  recoveryError: z.string().nullable(),
  startError: z.string().nullable(),
  startPendingReads: z.number(),
  ownedLocks: z.array(z.string())
});

/** Isolate a potential permanently queued request from the test runner's lock owners. */
export async function observeAutoRunStorageLockOrder(withSession: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planweave-lock-order-")));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import fs from 'node:fs/promises';
    import {join,dirname} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    import {AsyncLocalStorage} from 'node:async_hooks';
    const root=process.argv[1], source=process.argv[2], withSession=process.argv[3]==='session';
    const home=join(root,'home');await fs.mkdir(home);process.env.PLANWEAVE_HOME=home;
    const rt=await import(source+'index.ts');
    const api=await import(source+'desktop/runApi.ts');
    const tr=await import(source+'desktop/autoRunTransition.ts');
    const store=await import(source+'desktop/runStateRepository.ts');
    const storage=await import(source+'runSessions/storageMutation.ts');
    const draft=join(root,'draft');await fs.mkdir(draft);
    await fs.writeFile(join(draft,'manifest.json'),JSON.stringify({version:'plan-package/v1',project:{title:'Lock order',description:''},execution:{parallel:{enabled:false,maxConcurrent:1}},review:{maxFeedbackCycles:1,completionPolicy:'strict'},executors:{},nodes:[],edges:[]}));
    const {workspace:w}=await rt.importManagedPackage({name:'Lock order',draftRoot:draft,overwrite:false});
    const run=await storage.withCurrentRunSessionStorage(w,()=>api.initializeAutoRunUnderCanvasLock(w,w.workspaceRoot,'default',{kind:'project'},2,{tmuxEnabled:false,executorOverride:'manual'}));
    const stopped={...run,runSessionId:withSession?run.runSessionId:null,phase:'stopped',updatedAt:new Date().toISOString()};
    await store.writePersistedAutoRunState(stopped);
    await tr.writePendingTransitionIntent(w,{version:2,transitionId:'lock-order-proof',runId:run.runId,previousPhase:'running',nextPhase:'stopped',eventType:'run_stopped',previousAuthority:tr.buildExpectedAuthority(run),expectedAuthority:tr.buildExpectedAuthority(stopped),data:{},createdAt:new Date().toISOString()});
    const pending=tr.pendingTransitionPath(w,run.runId), autoRuns=join(w.resultsDir,'auto-runs');
    const context=new AsyncLocalStorage(),locks=new Set();
    const originalRead=fs.readFile,originalDir=fs.readdir,originalWrite=fs.writeFile;
    let readSeen,release,startSeen;
    const seen=new Promise(r=>readSeen=r),gate=new Promise(r=>release=r),scanned=new Promise(r=>startSeen=r);
    let heldRead=false,recoveryDone=false,startDone=false,startPendingReads=0,recoveryError=null,startError=null;
    fs.readFile=async(...args)=>{
      if(String(args[0])===pending){
        if(context.getStore()==='summary'&&!heldRead){heldRead=true;readSeen();await gate;}
        if(context.getStore()==='start')startPendingReads++;
      }
      return originalRead(...args);
    };
    fs.readdir=async(...args)=>{
      const result=await originalDir(...args);
      if(context.getStore()==='start'&&String(args[0])===autoRuns)startSeen();
      return result;
    };
    fs.writeFile=async(...args)=>{
      const result=await originalWrite(...args);
      if(String(args[0]).endsWith('/holder.json')){
        const holder=JSON.parse(String(args[1]));
        if(holder.pid===process.pid)locks.add(dirname(String(args[0])));
      }
      return result;
    };
    syncBuiltinESMExports();
    context.run('summary',()=>rt.getLatestAutoRunSummaryWithDiagnostics(w.workspaceRoot,'default'))
      .catch(error=>recoveryError=error.message).finally(()=>recoveryDone=true);
    await seen;
    context.run('start',()=>rt.startAutoRun(w.workspaceRoot,'default',{kind:'project'},2,{tmuxEnabled:false,executorOverride:'manual'}))
      .catch(error=>startError=error.message).finally(()=>startDone=true);
    await scanned;await new Promise(r=>setImmediate(r));release();
    // Both owners have reached the exact conflicting acquisition order before observing completion.
    await Promise.race([
      (async()=>{while(!recoveryDone||!startDone)await new Promise(r=>setImmediate(r));})(),
      new Promise(r=>setTimeout(r,1000))
    ]);
    if(recoveryDone&&startDone)await rt.shutdownDesktopAutoRuns();
    console.log(JSON.stringify({recoveryDone,startDone,recoveryError,startError,startPendingReads,ownedLocks:[...locks]}));
    process.exit(0);
  `,
      root,
      new URL("../../", import.meta.url).href,
      withSession ? "session" : "legacy"
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) throw new Error(`Lock-order fixture exited ${code}: ${errors}`);
    const result = observationSchema.parse(JSON.parse(output.trim().split("\n").at(-1) ?? ""));
    for (const lock of result.ownedLocks) {
      try {
        const holder = z
          .object({ pid: z.number() })
          .parse(JSON.parse(await readFile(join(lock, "holder.json"), "utf8")));
        if (holder.pid === child.pid) await rm(lock, { recursive: true, force: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return result;
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
}
