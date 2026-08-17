export function aggregateOutputSafety(...evidence) {
  const available = evidence.filter(Boolean);
  return {
    captureLimitExceeded: available.some((item) => item.captureLimitExceeded === true),
    credentialShapeDetected: available.some((item) => item.credentialShapeDetected === true),
    contentEmitted: available.some((item) => item.contentEmitted === true),
    evidenceComplete:
      available.length === evidence.length &&
      available.every(
        (item) =>
          typeof item.captureLimitExceeded === "boolean" &&
          typeof item.credentialShapeDetected === "boolean" &&
          typeof item.contentEmitted === "boolean"
      )
  };
}

export function outputSafetyPassed(outputSafety) {
  return (
    outputSafety?.evidenceComplete === true &&
    outputSafety.captureLimitExceeded === false &&
    outputSafety.credentialShapeDetected === false &&
    outputSafety.contentEmitted === false
  );
}

export function realProfileQualifies(result) {
  return (
    result?.hardConformance === true &&
    result?.benchmark?.passed === true &&
    result.deadlineExceeded === false &&
    Number.isFinite(result.elapsedMs) &&
    Number.isFinite(result.deadlineMs) &&
    result.elapsedMs <= result.deadlineMs &&
    result.primaryProcessGroupCleanupConfirmed === true &&
    result.processGroupCleanupConfirmed === true &&
    result.benchmark.cleanupConfirmed === true &&
    outputSafetyPassed(result.outputSafety) &&
    outputSafetyPassed(result.benchmark.outputSafety)
  );
}

export function decideGate(real) {
  return real.some(realProfileQualifies) ? "GO" : "NO-GO";
}
