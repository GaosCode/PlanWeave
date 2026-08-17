import { thresholds } from "./gate-config.mjs";
import { aggregateOutputSafety, outputSafetyPassed } from "./gate-evaluator.mjs";
import { ProcessTreeSampler } from "./process-tree-sampler.mjs";

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    max: sorted.at(-1)
  };
}

function reductionPercent(baseline, candidate) {
  return ((baseline - candidate) / baseline) * 100;
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

async function benchmarkRound({ launch, env, shared, options, createClient, initialize }) {
  const count = thresholds.workloadConcurrency;
  const items = [];
  const sampler = new ProcessTreeSampler({
    getRootPids: () => items.flatMap((item) => item.client.processId ?? []),
    getTelemetryClients: () => (launch.reportsGateMetrics ? items.map((item) => item.client) : []),
    telemetry: launch.reportsGateMetrics === true
  });
  const workloadStarted = performance.now();
  let processTree;
  let measurement;
  sampler.start();
  try {
    const processSlots = shared ? 1 : count;
    for (let index = 0; index < processSlots; index += 1) {
      items.push(
        createClient({
          launch,
          env,
          cwd: options.cwd,
          deadlineAt: options.deadlineAt,
          timeoutMs: 20_000,
          requestAudit: options.requestAudit
        })
      );
    }
    const initialized = await Promise.all(items.map((item) => initialize(item)));
    const workloadStartupInitializeWallMs = performance.now() - workloadStarted;
    const owners = [];
    for (let index = 0; index < count; index += 1) {
      const item = items[shared ? 0 : index];
      const owner = item.router.owner(`benchmark-${index}`);
      await item.router.open(owner);
      owners.push({ item, owner });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    processTree = await sampler.stop();
    await Promise.all(owners.map(({ item, owner }) => item.router.close(owner)));
    measurement = {
      processTree,
      workloadStartupInitializeWallMs,
      startupInitializeP95Ms: percentile95(initialized.map((item) => item.spawnToInitializeMs))
    };
  } finally {
    processTree ??= await sampler.stop();
    const cleanup = await Promise.all(items.map((item) => item.client.dispose()));
    if (measurement) {
      measurement.processGroupCleanupConfirmed = cleanup.every(
        (item) => item.processGroupCleanupConfirmed
      );
      measurement.outputSafety = {
        credentialShapeDetected: items.some(
          (item) => item.client.outputSafety.credentialShapeDetected
        ),
        captureLimitExceeded: items.some((item) => item.client.outputSafety.captureLimitExceeded),
        contentEmitted: false
      };
    }
  }
  return measurement;
}

export async function runBenchmark({
  launch,
  env,
  rounds,
  options = {},
  createClient,
  initialize
}) {
  const samples = [];
  for (let round = 0; round < rounds; round += 1) {
    samples.push({
      dedicated: await benchmarkRound({
        launch,
        env,
        shared: false,
        options,
        createClient,
        initialize
      }),
      shared: await benchmarkRound({
        launch,
        env,
        shared: true,
        options,
        createClient,
        initialize
      })
    });
  }
  return evaluateBenchmarkSamples(samples, rounds);
}

function processTreeEvidenceComplete(measurement) {
  return (
    (measurement.processTree.status === "measured-hermetic-agent-telemetry" ||
      measurement.processTree.status === "measured-os") &&
    measurement.processTree.coverageComplete === true &&
    measurement.processTree.failedSamples === 0
  );
}

export function evaluateBenchmarkSamples(samples, rounds) {
  const metrics = {};
  const metricReaders = {
    peakProcessTreeCount: (sample) => sample.processTree.peakProcessTreeCount,
    workloadStartupInitializeWallMs: (sample) => sample.workloadStartupInitializeWallMs,
    startupInitializeP95Ms: (sample) => sample.startupInitializeP95Ms,
    peakAggregateRssKiB: (sample) => sample.processTree.peakAggregateRssKiB
  };
  for (const [metric, read] of Object.entries(metricReaders)) {
    const dedicated = samples.map((sample) => read(sample.dedicated)).filter(Number.isFinite);
    const shared = samples.map((sample) => read(sample.shared)).filter(Number.isFinite);
    metrics[metric] =
      dedicated.length === rounds && shared.length === rounds
        ? { dedicated: summarize(dedicated), shared: summarize(shared) }
        : { dedicated: null, shared: null };
  }
  const processTreeEvidenceCompleteForAllSamples = samples.every(
    (sample) =>
      processTreeEvidenceComplete(sample.dedicated) && processTreeEvidenceComplete(sample.shared)
  );
  const complete =
    samples.length === rounds &&
    processTreeEvidenceCompleteForAllSamples &&
    Object.values(metrics).every((metric) => metric.dedicated != null && metric.shared != null);
  const cleanupConfirmed = samples.every(
    (sample) =>
      sample.dedicated.processGroupCleanupConfirmed && sample.shared.processGroupCleanupConfirmed
  );
  const outputSafety = aggregateOutputSafety(
    ...samples.flatMap((sample) => [sample.dedicated.outputSafety, sample.shared.outputSafety])
  );
  const outputSafe = outputSafetyPassed(outputSafety);
  const processReduction = complete
    ? reductionPercent(
        metrics.peakProcessTreeCount.dedicated.median,
        metrics.peakProcessTreeCount.shared.median
      )
    : null;
  const startupReduction = complete
    ? reductionPercent(
        metrics.workloadStartupInitializeWallMs.dedicated.median,
        metrics.workloadStartupInitializeWallMs.shared.median
      )
    : null;
  const rssReduction = complete
    ? reductionPercent(
        metrics.peakAggregateRssKiB.dedicated.median,
        metrics.peakAggregateRssKiB.shared.median
      )
    : null;
  const startupQualifies =
    complete && startupReduction >= thresholds.startupInitializeOrPeakRssReductionPercent;
  const rssQualifies =
    rssReduction != null && rssReduction >= thresholds.startupInitializeOrPeakRssReductionPercent;
  const otherMetricWithinLimit = startupQualifies
    ? rssReduction == null || rssReduction >= -thresholds.maximumOtherMetricRegressionPercent
    : rssQualifies && startupReduction >= -thresholds.maximumOtherMetricRegressionPercent;
  return {
    passed:
      complete &&
      cleanupConfirmed &&
      outputSafe &&
      processReduction >= thresholds.processReductionPercent &&
      (startupQualifies || rssQualifies) &&
      otherMetricWithinLimit,
    status:
      complete && cleanupConfirmed && outputSafe
        ? "measured"
        : "inconclusive-incomplete-process-tree-or-safety-evidence",
    rounds,
    cleanupConfirmed,
    outputSafe,
    outputSafety,
    processTreeEvidenceComplete: processTreeEvidenceCompleteForAllSamples,
    samples,
    metrics,
    reductionsPercent: {
      peakProcessTreeCount: processReduction,
      workloadStartupInitializeWall: complete ? startupReduction : null,
      peakAggregateRss: rssReduction
    }
  };
}
