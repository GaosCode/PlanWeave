import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const dist = new URL("../../../dist/", import.meta.url).href;

export type Actor = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  done: Promise<{ code: number | null; stderr: string }>;
  readonly observedHeld: boolean;
};

// Real child processes acknowledge either a completed replacement, or the existing reader lock.
// No clock delay determines the interleaving; stdout/stdin barriers control each filesystem stage.
export function spawnPackageMutation(
  root: string,
  kind: "replace" | "canvas-aba" | "import-aba",
  childTemp?: string
): Actor {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import * as fs from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import { dirname, join } from 'node:path';
    import { userInfo } from 'node:os';
    const root = process.argv[1], kind = process.argv[2], dist = process.argv[3];
    const { withPackageFileConsistency } = await import(dist+'package/packageFileConsistency.js');
    const { replacePackageFiles } = await import(dist+'package/packageFiles.js');
    const { ImportTransaction } = await import(dist+'package/importTransaction.js');
    const { quarantineCanvasWorkspace, restoreQuarantinedCanvasWorkspace, stageCanvasWorkspaceWrite, commitCanvasWorkspaceWrite } = await import(dist+'projectGraph/canvasWorkspaceRecovery.js');
    const key = createHash('sha256').update(await fs.realpath(root)).digest('hex');
    const lockPath = join(userInfo().homedir, '.cache','planweave','package-locks', key);
    const held = await fs.stat(lockPath).then(()=>true, error=>{if(error.code==='ENOENT')return false;throw error});
    const continued = new Promise(resolve=>{process.stdin.once('data',resolve);process.stdin.once('end',resolve)});
    if(held) process.stdout.write('held\\n');
    const files=[{path:'a.md',content:'new-A',encoding:'utf8'},{path:'b.md',content:'new-B-long',encoding:'utf8'}];
    if(kind==='replace') {
      await replacePackageFiles(root,files);
      if(!held)process.stdout.write('installed\\n');
    } else if(kind==='import-aba') {
      const staged=join(dirname(dirname(root)),'staged-import');
      await replacePackageFiles(staged,files);
      await withPackageFileConsistency([root],async()=>{
        const transaction=await ImportTransaction.create({workspaceRoot:dirname(dirname(root))});
        await transaction.replacePath(root,staged);
        if(!held)process.stdout.write('installed\\n');
        await continued;
        await transaction.rollback();
      });
    } else {
      const workspaceRoot=dirname(dirname(root));
      const project={id:'fixture',kind:'external',rootPath:workspaceRoot,sourceRoot:workspaceRoot,planweaveHome:workspaceRoot,
        workspaceRoot,projectFile:join(workspaceRoot,'project.json'),packageDir:join(workspaceRoot,'package'),
        manifestFile:join(workspaceRoot,'package','manifest.json'),stateFile:join(workspaceRoot,'state.json'),resultsDir:join(workspaceRoot,'results'),projectPromptFile:join(workspaceRoot,'project-prompt.md')};
      const canvas=dirname(root);
      const staged=await stageCanvasWorkspaceWrite(project,{canvasId:'next',finalRoot:join(project.workspaceRoot,'replacement')});
      await replacePackageFiles(staged.workspace.packageDir,files);
      await withPackageFileConsistency([root],async()=>{
        const original=await quarantineCanvasWorkspace(project,{canvasId:'original',workspaceRoot:canvas});
        if(!original)throw new Error('original canvas missing');
        await commitCanvasWorkspaceWrite(project,{...staged,finalRoot:canvas});
        if(!held)process.stdout.write('installed\\n');
        await continued;
        await quarantineCanvasWorkspace(project,{canvasId:'replacement',workspaceRoot:canvas});
        await restoreQuarantinedCanvasWorkspace(project,{quarantineRoot:original,workspaceRoot:canvas});
      });
    }
    process.stdin.destroy();
  `,
      root,
      kind,
      dist
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: childTemp
        ? { ...process.env, TMPDIR: childTemp, HOME: childTemp, PLANWEAVE_HOME: childTemp }
        : process.env
    }
  );
  let stderr = "";
  child.stderr.on("data", (value) => {
    stderr += String(value);
  });
  let observedHeld = false;
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", (value) => {
      observedHeld = String(value).startsWith("held");
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(stderr));
    });
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  void done.catch(() => undefined);
  const actor = {
    child,
    ready,
    done,
    get observedHeld() {
      return observedHeld;
    }
  };
  return actor;
}

export async function holdPackageLock(root: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { withPackageFileConsistency } = await import(process.argv[2]+'package/packageFileConsistency.js');
    await withPackageFileConsistency([process.argv[1]], async()=>{
      process.stdout.write('held\\n');
      await new Promise(resolve=>process.stdin.once('data',resolve));
    });
    process.stdin.destroy();
  `,
      root,
      dist
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (value) => {
    stderr += String(value);
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }
  );
  void done.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(stderr));
    });
  });
  return { child, done };
}
