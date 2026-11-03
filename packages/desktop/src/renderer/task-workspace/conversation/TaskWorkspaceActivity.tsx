import type { RunnerRecordReadModel } from "@planweave-ai/runtime";
import { LoaderCircleIcon } from "lucide-react";

export function TaskWorkspaceActivity({
  model,
  active,
  label
}: {
  model: RunnerRecordReadModel;
  active: boolean;
  label: string;
}) {
  if (!active || model.interaction.active) return null;
  let thinking = false;
  for (let index = model.events.length - 1; index >= 0; index -= 1) {
    const { body } = model.events[index]!;
    if (body.kind === "activity") {
      thinking = true;
      break;
    }
    if (
      body.kind === "message" ||
      body.kind === "tool_call" ||
      body.kind === "tool_update" ||
      body.kind === "terminal"
    )
      return null;
  }
  if (!thinking) return null;
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground" role="status">
      <LoaderCircleIcon
        aria-hidden="true"
        className="size-3 animate-spin motion-reduce:animate-none"
      />
      {label}
    </div>
  );
}
