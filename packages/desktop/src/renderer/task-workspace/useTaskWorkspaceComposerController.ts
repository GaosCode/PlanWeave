import { useEffect, useRef, useState } from "react";
import { useAgentPrompt } from "../hooks/useAgentPrompt";
import type { TaskWorkspaceComposerSlotProps } from "./contracts";
import { promptIdentityKey, samePromptIdentity } from "./conversation/actionIdentity";

type Draft = { text: string; revision: number };

export function useTaskWorkspaceComposerController({
  api,
  runnerModel,
  selectedRun,
  scopeKey = "task-workspace"
}: Pick<TaskWorkspaceComposerSlotProps, "runnerModel" | "selectedRun"> & {
  api: Parameters<typeof useAgentPrompt>[0]["api"];
  scopeKey?: string;
}) {
  const modelIdentity = runnerModel?.intervention.prompt.identity ?? null;
  const selectedCapability = selectedRun?.item.run.capabilities.prompt;
  const selectedRecordId = selectedRun?.item.run.record.recordId ?? null;
  const selectedIdentity = selectedCapability?.identity ?? null;
  /**
   * The list row is a summary projection and may carry no prompt identity at all
   * (it is only filled in when the Runtime loaded the run's full record). The
   * live read model, on the other hand, always knows its own identity. Requiring
   * both sides to agree used to report "the prompt identity does not match the
   * selected run" for the run the user was looking at, simply because one side
   * had nothing to compare.
   *
   * When the row has no identity, fall back to matching the read model's own
   * record id against the selection — the guard still refuses to act on a run
   * other than the selected one.
   */
  const identity =
    modelIdentity !== null &&
    (selectedIdentity !== null
      ? samePromptIdentity(modelIdentity, selectedIdentity)
      : selectedRecordId !== null && modelIdentity.recordId === selectedRecordId)
      ? modelIdentity
      : null;
  const key = identity ? promptIdentityKey(identity) : null;
  const scope = useRef({ key: scopeKey, drafts: new Map<string, Draft>() });
  if (scope.current.key !== scopeKey) {
    scope.current = { key: scopeKey, drafts: new Map() };
  }
  const drafts = scope.current.drafts;
  useEffect(() => () => drafts.clear(), [drafts]);
  const [, render] = useState(0);
  const prompt = useAgentPrompt({
    api,
    identity,
    runtimeInFlight: runnerModel?.intervention.prompt.inFlight ?? false,
    runtimeVersion: runnerModel,
    completedContinuation: runnerModel?.terminal ?? false,
    scopeKey
  });
  /**
   * `runnerModel` is the authoritative verdict for this record; the list row's
   * flag is a stub whenever the Runtime did not load the full record. Gating on
   * it disabled the composer for runs that were perfectly continuable.
   */
  const available = Boolean(runnerModel?.intervention.prompt.available && identity);
  const disabled = !available || prompt.inFlight;
  const draft = key ? (drafts.get(key)?.text ?? "") : "";
  const setDraft = (text: string) => {
    if (!key) return;
    const revision = (drafts.get(key)?.revision ?? 0) + 1;
    drafts.set(key, { text, revision });
    render((version) => version + 1);
  };
  const submit = () => {
    if (!key || disabled) return;
    const sentDraft = drafts.get(key);
    const text = sentDraft?.text.trim();
    if (!sentDraft || !text) return;
    void prompt.send(text).then((sent) => {
      if (
        !sent ||
        scope.current.drafts !== drafts ||
        drafts.get(key)?.revision !== sentDraft.revision
      )
        return;
      drafts.delete(key);
      render((version) => version + 1);
    });
  };
  return { available, disabled, draft, identity, prompt, setDraft, submit };
}

export type TaskWorkspaceComposerController = ReturnType<typeof useTaskWorkspaceComposerController>;
