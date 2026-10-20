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
  const identity = samePromptIdentity(modelIdentity, selectedCapability?.identity ?? null)
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
  const available = Boolean(
    runnerModel?.intervention.prompt.available && selectedCapability?.available && identity
  );
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
