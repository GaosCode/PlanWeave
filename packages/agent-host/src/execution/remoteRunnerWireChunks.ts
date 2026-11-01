import {
  remoteRunnerEventFragmentSchema,
  type RemoteRunnerEventFragment
} from "@planweave-ai/agent-host-protocol";

export function remoteRunnerWireChunks(
  fragment: RemoteRunnerEventFragment,
  fits: (fragment: RemoteRunnerEventFragment, index: number) => boolean
): RemoteRunnerEventFragment[] {
  remoteRunnerEventFragmentSchema.parse(fragment);
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
  const split = (start: number, end: number): void => {
    const candidate: RemoteRunnerEventFragment = {
      kind: "runner_body",
      body: { ...body, content: characters.slice(start, end).join("") }
    };
    if (fits(candidate, chunks.length)) {
      chunks.push(candidate);
      return;
    }
    if (end - start <= 1) throw new Error("agent_host_outbound_payload_too_large");
    const middle = start + Math.floor((end - start) / 2);
    split(start, middle);
    split(middle, end);
  };
  if (characters.length === 0) throw new Error("agent_host_outbound_payload_too_large");
  const middle = Math.floor(characters.length / 2);
  if (middle === 0) throw new Error("agent_host_outbound_payload_too_large");
  split(0, middle);
  split(middle, characters.length);
  return chunks;
}
