const { withAdvisoryDirectoryLock } = await import(process.argv[2]);
const { lockPath, missing, actor } = JSON.parse(process.argv[3]);
try {
  await withAdvisoryDirectoryLock({ lockPath, operation: actor, timeoutMs: 500 }, async (scope) => {
    process.send({ event: "entered", actor, pid: process.pid });
    if (actor === "first")
      await scope.runManagedCommand({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: missing
      });
  });
  process.send({ event: "success", actor, pid: process.pid });
} catch (error) {
  process.send({
    event: "failed",
    actor,
    pid: process.pid,
    code: error.code,
    message: String(error)
  });
}
process.disconnect();
