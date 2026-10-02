import { startVitest } from "vitest/node";

const [config, maxWorkers, ...files] = process.argv.slice(2);
if (!config || !files.length) {
  throw new Error("A suite config and exact test files are required.");
}

await startVitest("test", [], {
  config,
  run: true,
  maxWorkers: Number(maxWorkers),
  include: files.map((file) => file.replace(/([*?[\]{}()!+@])/g, "\\$1"))
});
