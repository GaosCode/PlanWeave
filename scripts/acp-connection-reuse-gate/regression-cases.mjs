import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateBenchmarkSamples } from "./benchmark-runner.mjs";
import { aggregateOutputSafety, decideGate, realProfileQualifies } from "./gate-evaluator.mjs";
import { createPrivateOutputTarget, writePrivateResult } from "./safe-output.mjs";

const safeOutput = {
  captureLimitExceeded: false,
  credentialShapeDetected: false,
  contentEmitted: false
};

function benchmarkMeasurement({ shared, processTree = {} }) {
  return {
    processTree: {
      status: "measured-hermetic-agent-telemetry",
      samples: 4,
      failedSamples: 0,
      coverageComplete: true,
      peakProcessTreeCount: shared ? 1 : 4,
      peakAggregateRssKiB: shared ? 40_000 : 160_000,
      ...processTree
    },
    workloadStartupInitializeWallMs: shared ? 70 : 100,
    startupInitializeP95Ms: shared ? 70 : 100,
    processGroupCleanupConfirmed: true,
    outputSafety: safeOutput
  };
}

const partialObserverFailure = Array.from({ length: 3 }, () => ({
  dedicated: benchmarkMeasurement({
    shared: false,
    processTree: {
      status: "not-measured-process-tree-observer-unavailable",
      failedSamples: 1,
      coverageComplete: false
    }
  }),
  shared: benchmarkMeasurement({ shared: true })
}));
const partialResult = evaluateBenchmarkSamples(partialObserverFailure, 3);
assert.equal(partialResult.passed, false);
assert.equal(partialResult.processTreeEvidenceComplete, false);
assert.equal(partialResult.reductionsPercent.peakProcessTreeCount, null);

const benchmarkOutputSafety = aggregateOutputSafety(safeOutput);
const qualifyingProfile = {
  hardConformance: true,
  deadlineMs: 20_000,
  elapsedMs: 1_000,
  deadlineExceeded: false,
  primaryProcessGroupCleanupConfirmed: true,
  processGroupCleanupConfirmed: true,
  outputSafety: aggregateOutputSafety(safeOutput, safeOutput),
  benchmark: {
    passed: true,
    cleanupConfirmed: true,
    outputSafety: benchmarkOutputSafety
  }
};
assert.equal(realProfileQualifies(qualifyingProfile), true);
assert.equal(realProfileQualifies({ ...qualifyingProfile, deadlineExceeded: true }), false);
assert.equal(
  realProfileQualifies({ ...qualifyingProfile, primaryProcessGroupCleanupConfirmed: false }),
  false
);
assert.equal(
  realProfileQualifies({ ...qualifyingProfile, processGroupCleanupConfirmed: false }),
  false
);
assert.equal(
  realProfileQualifies({
    ...qualifyingProfile,
    benchmark: { ...qualifyingProfile.benchmark, cleanupConfirmed: false }
  }),
  false
);

const unsafeBenchmark = {
  ...qualifyingProfile.benchmark,
  outputSafety: aggregateOutputSafety(safeOutput, {
    ...safeOutput,
    credentialShapeDetected: true
  })
};
const benchmarkCredentialProfile = {
  ...qualifyingProfile,
  benchmark: unsafeBenchmark,
  outputSafety: aggregateOutputSafety(safeOutput, unsafeBenchmark.outputSafety)
};
assert.equal(benchmarkCredentialProfile.outputSafety.credentialShapeDetected, true);
assert.equal(realProfileQualifies(benchmarkCredentialProfile), false);
assert.equal(decideGate([benchmarkCredentialProfile]), "NO-GO");

const cleanupRoots = [];
try {
  const parentTarget = createPrivateOutputTarget();
  cleanupRoots.push(parentTarget.directory, `${parentTarget.directory}-moved`);
  const outside = mkdtempSync(join(tmpdir(), "planweave-acp-gate-outside-"));
  cleanupRoots.push(outside);
  renameSync(parentTarget.directory, `${parentTarget.directory}-moved`);
  symlinkSync(outside, parentTarget.directory, "dir");
  assert.throws(
    () => writePrivateResult(parentTarget, "{}\n"),
    /Private output directory is no longer a real directory/
  );

  const finalTarget = createPrivateOutputTarget();
  cleanupRoots.push(finalTarget.directory);
  symlinkSync(join(finalTarget.directory, "elsewhere.json"), finalTarget.filePath);
  assert.throws(() => writePrivateResult(finalTarget, "{}\n"), /already exists/);
} finally {
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  `${JSON.stringify({
    partialObserverFailureRejected: true,
    deadlineAndCleanupFailuresRejected: true,
    benchmarkCredentialOutputRejected: true,
    outputSymlinksRejected: true
  })}\n`
);
