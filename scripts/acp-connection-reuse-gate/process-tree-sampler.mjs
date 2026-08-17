import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseProcessTable(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (parts) =>
        parts.length === 3 && parts.every((value) => Number.isSafeInteger(value) && value >= 0)
    )
    .map(([pid, parentPid, rssKiB]) => ({ pid, parentPid, rssKiB }));
}

function processTreeRows(rows, rootPids) {
  const included = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!included.has(row.pid) && included.has(row.parentPid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => included.has(row.pid));
}

export class ProcessTreeSampler {
  constructor({ getRootPids, getTelemetryClients, telemetry = false, intervalMs = 10 }) {
    this.getRootPids = getRootPids;
    this.getTelemetryClients = getTelemetryClients;
    this.telemetry = telemetry;
    this.intervalMs = intervalMs;
    this.samples = 0;
    this.peakProcessTreeCount = 0;
    this.peakAggregateRssKiB = 0;
    this.status = "not-measured";
    this.failedSamples = 0;
    this.running = false;
    this.windowCompleted = false;
    this.inFlight = null;
  }

  start() {
    this.running = true;
    this.schedule();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.inFlight) await this.inFlight;
    this.windowCompleted = true;
    return this.result();
  }

  result() {
    return {
      status: this.status,
      samples: this.samples,
      failedSamples: this.failedSamples,
      coverageComplete:
        this.windowCompleted && this.samples > 0 && this.failedSamples === 0 && this.isMeasured(),
      peakProcessTreeCount: this.samples > 0 ? this.peakProcessTreeCount : null,
      peakAggregateRssKiB: this.samples > 0 ? this.peakAggregateRssKiB : null
    };
  }

  schedule() {
    if (!this.running) return;
    this.inFlight = this.sample()
      .catch(() => {
        this.failedSamples += 1;
        this.status = "not-measured-process-tree-observer-unavailable";
        this.running = false;
      })
      .finally(() => {
        this.inFlight = null;
        if (this.running) this.timer = setTimeout(() => this.schedule(), this.intervalMs);
      });
  }

  async sample() {
    const telemetryClients = this.getTelemetryClients?.() ?? [];
    const rows = this.telemetry
      ? await this.sampleHermeticTelemetry(telemetryClients)
      : await this.sampleOperatingSystem();
    if (rows.length === 0) return;
    this.samples += 1;
    this.status = this.telemetry ? "measured-hermetic-agent-telemetry" : "measured-os";
    this.peakProcessTreeCount = Math.max(this.peakProcessTreeCount, rows.length);
    this.peakAggregateRssKiB = Math.max(
      this.peakAggregateRssKiB,
      rows.reduce((total, row) => total + row.rssKiB, 0)
    );
  }

  isMeasured() {
    return this.status === "measured-hermetic-agent-telemetry" || this.status === "measured-os";
  }

  async sampleHermeticTelemetry(clients) {
    if (clients.length === 0) return [];
    const results = await Promise.allSettled(
      clients.map((client) => client.request("gate/metrics", {}, 250))
    );
    if (results.some((result) => result.status !== "fulfilled")) {
      throw new Error("Hermetic process telemetry was incomplete.");
    }
    return results.map((result) => {
      if (result.status !== "fulfilled") throw new Error("Hermetic process telemetry failed.");
      const { pid, parentPid, rssKiB } = result.value ?? {};
      if (
        !Number.isSafeInteger(pid) ||
        !Number.isSafeInteger(parentPid) ||
        !Number.isSafeInteger(rssKiB)
      ) {
        throw new Error("Hermetic process telemetry was malformed.");
      }
      return { pid, parentPid, rssKiB };
    });
  }

  async sampleOperatingSystem() {
    if (process.platform === "win32") {
      throw new Error("Windows process-tree sampling is not implemented.");
    }
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], {
      maxBuffer: 4_194_304,
      timeout: 1_000
    });
    const rootPids = this.getRootPids();
    const rows = processTreeRows(parseProcessTable(stdout), rootPids);
    if (rootPids.length > 0 && rows.length === 0) {
      throw new Error("Process-tree observer did not find an active root process.");
    }
    return rows;
  }
}
