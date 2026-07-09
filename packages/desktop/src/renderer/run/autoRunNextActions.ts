import type {
  AutoRunNextAction,
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunState
} from "@planweave-ai/runtime";

export type AutoRunNextActionCommand =
  | "start"
  | "wait"
  | "resume"
  | "copy_manual_command"
  | "inspect_record"
  | "retry_ref"
  | "review_status";

export type AutoRunNextActionDescriptor = {
  command: AutoRunNextActionCommand;
  enabled: boolean;
  disabledReason: string | null;
  label: string;
  message: string;
  nextActionKind: AutoRunNextAction["kind"];
  ref: string | null;
  recordId: string | null;
  targetPath: string | null;
  manualCommand: string | null;
};

type AutoRunNextActionLabels = {
  copyManualCommand: string;
  inspectRecord: string;
  retryRef: string;
  reviewStatus: string;
  resume: string;
  start: string;
  wait: string;
};

type AutoRunNextActionContext = {
  labels: AutoRunNextActionLabels;
  noCommandReason: string;
  noRecordReason: string;
  noRefReason: string;
  noRunReason: string;
  noScopeReason: string;
  selectedScopeReady: boolean;
  state: DesktopAutoRunState | null;
  retrospective: DesktopAutoRunRetrospectiveSummary | null;
};

function descriptor(
  input: Omit<AutoRunNextActionDescriptor, "disabledReason" | "enabled"> & {
    disabledReason?: string | null;
    enabled: boolean;
  }
): AutoRunNextActionDescriptor {
  return {
    ...input,
    disabledReason: input.enabled ? null : (input.disabledReason ?? null)
  };
}

export function buildAutoRunNextActionDescriptor(
  context: AutoRunNextActionContext
): AutoRunNextActionDescriptor | null {
  const source = context.state?.explanation.nextAction ?? context.retrospective?.nextAction ?? null;
  if (!source) {
    return null;
  }
  const recordId = context.state?.latestRecordId ?? context.retrospective?.latestRecordId ?? null;
  const recordPath =
    context.state?.latestRecordPath ??
    context.retrospective?.latestRecordPath ??
    source.targetPath ??
    null;
  const ref = source.ref ?? context.state?.currentRef ?? context.retrospective?.blockedRef ?? null;
  const base = {
    manualCommand: source.command,
    message: source.message,
    nextActionKind: source.kind,
    recordId,
    ref,
    targetPath: recordPath
  };

  switch (source.kind) {
    case "start":
      return descriptor({
        ...base,
        command: "start",
        enabled: context.selectedScopeReady,
        disabledReason: context.noScopeReason,
        label: context.labels.start
      });
    case "wait":
      return descriptor({
        ...base,
        command: "wait",
        enabled: false,
        disabledReason: source.message,
        label: context.labels.wait
      });
    case "resume":
      return descriptor({
        ...base,
        command: "resume",
        enabled: Boolean(context.state?.runId),
        disabledReason: context.noRunReason,
        label: context.labels.resume
      });
    case "submit_manual_result":
      return descriptor({
        ...base,
        command: "copy_manual_command",
        enabled: Boolean(source.command),
        disabledReason: context.noCommandReason,
        label: context.labels.copyManualCommand
      });
    case "inspect_record":
      return descriptor({
        ...base,
        command: "inspect_record",
        enabled: Boolean(recordId || recordPath),
        disabledReason: context.noRecordReason,
        label: context.labels.inspectRecord
      });
    case "resolve_error":
      return descriptor({
        ...base,
        command: "retry_ref",
        enabled: Boolean(ref),
        disabledReason: context.noRefReason,
        label: context.labels.retryRef
      });
    case "review_status":
      return descriptor({
        ...base,
        command: "review_status",
        enabled: Boolean(recordId || recordPath),
        disabledReason: context.noRecordReason,
        label: context.labels.reviewStatus
      });
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
