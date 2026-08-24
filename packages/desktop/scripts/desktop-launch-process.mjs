import { spawn } from "node:child_process";

export function startDesktopChild({
  command,
  args,
  options,
  spawnChild = spawn,
  parentProcess = process,
  writeError = console.error
}) {
  const child = spawnChild(command, args, options);
  let stopping = false;
  let terminalFailure = false;
  const signalHandlers = new Map();

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      parentProcess.off(signal, handler);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      stopping = true;
      if (!child.kill(signal)) {
        terminalFailure = true;
        parentProcess.exitCode = 1;
      }
    };
    signalHandlers.set(signal, handler);
    parentProcess.once(signal, handler);
  }

  child.once("error", (error) => {
    terminalFailure = true;
    removeSignalHandlers();
    writeError(error);
    parentProcess.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    removeSignalHandlers();
    parentProcess.exitCode = terminalFailure ? 1 : (code ?? (stopping ? 0 : signal ? 1 : 0));
  });
  return child;
}
