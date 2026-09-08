import type { CaptureSample, CaptureTrace } from "./collaborationCapture.js";

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
