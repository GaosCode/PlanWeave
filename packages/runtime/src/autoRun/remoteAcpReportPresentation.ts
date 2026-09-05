import { FINAL_ARTIFACT_MARKER, finalArtifactEnvelopeSchema } from "./finalArtifactEnvelope.js";
import type { AcpTimelineItem } from "./acpConversationProjection.js";

/** Render the completed report text without treating its envelope as an accepted artifact. */
export function presentRemoteAcpReport(items: AcpTimelineItem[]): AcpTimelineItem[] {
  let index = -1;
  for (let position = items.length - 1; position >= 0; position -= 1) {
    const candidate = items[position];
    if (candidate?.kind === "message" && candidate.role === "assistant") {
      index = position;
      break;
    }
  }
  const item = items[index];
  if (!item || item.kind !== "message") return items;
  const marker = item.content.lastIndexOf(FINAL_ARTIFACT_MARKER);
  if (marker < 0) return items;
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.content.slice(marker + FINAL_ARTIFACT_MARKER.length).trim());
  } catch {
    return items;
  }
  const envelope = finalArtifactEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return items;
  const prefix = item.content.slice(0, marker).trimEnd();
  const artifact = envelope.data.artifact;
  const content =
    prefix ||
    (artifact.kind === "review"
      ? JSON.stringify(artifact.reviewResult, null, 2)
      : artifact.reportMarkdown);
  return items.map((entry, position) => (position === index ? { ...item, content } : entry));
}
