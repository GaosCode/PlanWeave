import { execFile } from "node:child_process";

export type FixedArgvOptions = {
  readonly environment?: Readonly<Record<string, string>>;
  readonly budgetMs?: number;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
};

export type FixedArgvRunner = (
  executable: string,
  args: readonly string[],
  options?: FixedArgvOptions
) => Promise<{ stdout: string; stderr: string }>;

export const runFixedArgv: FixedArgvRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error("agent_host_background_query_cancelled"));
      return;
    }
    const remaining = Math.min(
      options?.budgetMs ?? Infinity,
      options?.deadline === undefined ? Infinity : options.deadline - Date.now()
    );
    if (remaining <= 0) {
      reject(new Error("agent_host_background_query_timeout"));
      return;
    }
    if (Number.isNaN(remaining)) {
      reject(new Error("agent_host_background_query_budget_invalid"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupted: Error | undefined;
    const child = execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        windowsHide: true,
        ...(options?.environment ? { env: { ...process.env, ...options.environment } } : {})
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        if (interrupted) reject(interrupted);
        else if (error) reject(error);
        else resolve({ stdout, stderr });
      }
    );
    const interrupt = (code: string) => {
      if (interrupted) return;
      interrupted = new Error(code);
      // execFile's callback follows process close; killing never resolves the query early.
      child.kill("SIGKILL");
    };
    const cancel = () => interrupt("agent_host_background_query_cancelled");
    options?.signal?.addEventListener("abort", cancel, { once: true });
    if (options?.signal?.aborted) cancel();
    if (Number.isFinite(remaining)) {
      timer = setTimeout(() => interrupt("agent_host_background_query_timeout"), remaining);
    }
  });
