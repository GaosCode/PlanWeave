import type { CaptureSample, CaptureTrace } from "./collaborationCapture.js";

/** Missing evidence is a coverage gap, not a zero-latency measurement. */
export function captureCoverage(trace: CaptureTrace) {
  const count = (stage: CaptureSample["stage"]) =>
    trace.samples.filter((s) => s.stage === stage).length;
  return {
    incomingUpdates: count("socket_receive"),
    probeReplies: count("transport_probe"),
    probeFailures: count("transport_probe_timeout") + count("transport_probe_error"),
    unsupported: count("transport_probe_unavailable") > 0,
    clientWrites: count("socket_write"),
    serverWrites: count("server_write"),
    serverLoopSamples: count("server_event_loop_delay"),
    serverDroppedRecords: trace.samples.reduce(
      (sum, sample) => sum + (sample.diagnostics?.droppedRecords ?? 0),
      0
    ),
    networkEvidence: "separate-network-collector-required" as const
  };
}

function distribution(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => ordered[Math.ceil(ordered.length * p) - 1];
  return {
    count: ordered.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: ordered[ordered.length - 1],
    over100Ms: ordered.filter((v) => v > 100).length
  };
}

/** Local coalescing never allocates a wire sequence or implies a lost network update. */
export function summarizePresenceQueue(trace: CaptureTrace) {
  const sent = trace.samples.filter((sample) => sample.stage === "socket_send");
  const buffered = trace.samples.flatMap((sample) =>
    (sample.stage === "socket_send" || sample.stage === "presence_buffer") &&
    sample.bufferedBytes !== undefined
      ? [sample.bufferedBytes]
      : []
  );
  return {
    sentUpdates: sent.length,
    coalescedUpdates: trace.samples.filter((sample) => sample.stage === "presence_coalesced")
      .length,
    queueWait: distribution(
      trace.samples.flatMap((sample) =>
        sample.stage === "presence_queue_wait" && sample.durationMs !== undefined
          ? [sample.durationMs]
          : []
      )
    ),
    bufferedBytesHighWater: buffered.length ? Math.max(...buffered) : null
  };
}

/** Arrival cadence is grouped by peer and pointer presence, never treated as one-way latency. */
export function summarizeCapture(trace: CaptureTrace) {
  const groups = new Map<string, CaptureSample[]>();
  for (const sample of trace.samples) {
    const key = `${sample.stage}${sample.peer === undefined ? "" : `:peer-${sample.peer}`}${sample.pointer === undefined ? "" : `:pointer-${sample.pointer}`}`;
    const samples = groups.get(key) ?? [];
    samples.push(sample);
    groups.set(key, samples);
  }
  return [...groups].map(([stream, samples]) => ({
    stream,
    count: samples.length,
    intervalsIncludingInputPauses: distribution(
      samples.slice(1).map((s, i) => s.atMs - samples[i].atMs)
    ),
    durations: distribution(
      samples.flatMap((s) => (s.durationMs === undefined ? [] : [s.durationMs]))
    )
  }));
}
