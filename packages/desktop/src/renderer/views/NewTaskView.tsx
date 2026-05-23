import type { Dispatch, SetStateAction } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary, DesktopTaskDraft, DesktopTaskDraftMode } from "@planweave/runtime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { createTranslator } from "../i18n";
import type { AppView } from "../types";

type NewTaskViewProps = {
  confirmTaskDraft: () => Promise<void>;
  generateTaskDraft: () => Promise<void>;
  graph: DesktopGraphViewModel | null;
  newTaskMode: DesktopTaskDraftMode;
  newTaskTargetId: string | null;
  newTaskText: string;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setNewTaskMode: Dispatch<SetStateAction<DesktopTaskDraftMode>>;
  setNewTaskTargetId: Dispatch<SetStateAction<string | null>>;
  setNewTaskText: Dispatch<SetStateAction<string>>;
  t: ReturnType<typeof createTranslator>;
  taskDraft: DesktopTaskDraft | null;
};

export function NewTaskView({
  confirmTaskDraft,
  generateTaskDraft,
  graph,
  newTaskMode,
  newTaskTargetId,
  newTaskText,
  selectedProject,
  setActiveView,
  setNewTaskMode,
  setNewTaskTargetId,
  setNewTaskText,
  t,
  taskDraft
}: NewTaskViewProps) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-4">
      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>{t("authoring")}</CardTitle>
          <CardDescription>{t("taskInputHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel>{t("creationMode")}</FieldLabel>
              <Select value={newTaskMode} onValueChange={(value) => setNewTaskMode(value as DesktopTaskDraftMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="task">{t("createTaskNode")}</SelectItem>
                    <SelectItem value="blocks">{t("appendBlocks")}</SelectItem>
                    <SelectItem value="document">{t("documentTasks")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {newTaskMode === "blocks" ? (
              <Field>
                <FieldLabel>{t("targetTask")}</FieldLabel>
                <Select value={newTaskTargetId ?? ""} onValueChange={setNewTaskTargetId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {graph?.tasks.map((task) => (
                        <SelectItem value={task.taskId} key={task.taskId}>
                          {task.title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field>
              <FieldLabel>{t("taskInput")}</FieldLabel>
              <Textarea data-testid="new-task-input" className="min-h-64 resize-none" value={newTaskText} onChange={(event) => setNewTaskText(event.target.value)} />
              <FieldDescription>{t("taskInputHint")}</FieldDescription>
            </Field>
            <div className="flex gap-2">
              <Button data-testid="new-task-generate-draft" onClick={() => void generateTaskDraft()}>
                {t("generateDraft")}
              </Button>
              <Button variant="outline" onClick={() => setActiveView("graph")}>
                {t("skipToCanvas")}
              </Button>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>
      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>{t("draftPreview")}</CardTitle>
          <CardDescription>{selectedProject?.name ?? t("noProject")}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-col gap-3">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 pr-2">
              {taskDraft?.tasks.map((task, index) => (
                <div className="flex flex-col gap-2 rounded-lg border p-3" key={`${task.title}-${index}`}>
                  <div className="text-sm font-medium">{task.title}</div>
                  <div className="text-xs text-muted-foreground">{task.blockTypes.join(" / ")}</div>
                  <div className="line-clamp-4 text-xs text-muted-foreground">{task.promptMarkdown}</div>
                </div>
              ))}
              {taskDraft?.blocks.map((block, index) => (
                <div className="flex flex-col gap-2 rounded-lg border p-3" key={`${block.taskId}-${block.title}-${index}`}>
                  <div className="text-sm font-medium">{block.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {block.taskId} · {block.type}
                  </div>
                  <div className="line-clamp-4 text-xs text-muted-foreground">{block.promptMarkdown}</div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <Button data-testid="new-task-confirm-write" disabled={!taskDraft} onClick={() => void confirmTaskDraft()}>
            {t("confirmWrite")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
