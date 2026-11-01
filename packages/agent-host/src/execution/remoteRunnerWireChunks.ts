import type { RemoteRunnerEventFragment } from "@planweave-ai/agent-host-protocol";

export function remoteRunnerWireChunks(
  fragment: RemoteRunnerEventFragment,
  fits: (fragment: RemoteRunnerEventFragment, index: number) => boolean
): RemoteRunnerEventFragment[] {
  if (fits(fragment, 0)) return [fragment];
  if (fragment.kind !== "runner_body") throw new Error("agent_host_outbound_payload_too_large");
  const body = fragment.body;
  if (
    body.kind !== "output" &&
    body.kind !== "terminal_output" &&
    !(body.kind === "message" && body.chunk)
  )
    throw new Error("agent_host_outbound_payload_too_large");
  const characters = Array.from(body.content);
  const chunks: RemoteRunnerEventFragment[] = [];
  let offset = 0;
  while (offset < characters.length) {
    const candidate = (length: number): RemoteRunnerEventFragment => ({
      kind: "runner_body",
      body: { ...body, content: characters.slice(offset, offset + length).join("") }
    });
    let low = 0;
    let high = characters.length - offset;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      if (fits(candidate(length), chunks.length)) low = length;
      else high = length - 1;
    }
    if (low === 0) throw new Error("agent_host_outbound_payload_too_large");
    chunks.push(candidate(low));
    offset += low;
  }
  if (chunks.length === 0) throw new Error("agent_host_outbound_payload_too_large");
  return chunks;
}
