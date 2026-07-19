import { useRef, type Dispatch, type SetStateAction } from "react";
import type {
  BlockType,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopTaskDraft,
  DesktopTaskDraftMode
} from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { createTranslator } from "../i18n";
import type { AppView } from "../types";

let nextDraftItemKey = 0;

function syncDraftItemKeys(keys: string[], length: number, prefix: string): void {
  while (keys.length < length) {
    nextDraftItemKey += 1;
    keys.push(`${prefix}-${nextDraftItemKey}`);
  }
  keys.length = length;
}

function pairDraftItems<T>(items: T[], keys: string[]): Array<{ item: T; key: string }> {
  return items.map((item, position) => {
    const key = keys[position];
    if (!key) {
      throw new Error("Draft item key synchronization failed.");
    }
    return { item, key };
  });
}

type NewTaskViewProps = {
  confirmTaskDraft: () => Promise<void>;
  generateTaskDraft: () => Promise<void>;
  graph: DesktopGraphViewModel | null;
  handleOpenProject: () => Promise<void>;
  newTaskMode: DesktopTaskDraftMode;
  newTaskTargetId: string | null;
  newTaskText: string;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setNewTaskMode: Dispatch<SetStateAction<DesktopTaskDraftMode>>;
  setNewTaskTargetId: Dispatch<SetStateAction<string | null>>;
  setNewTaskText: Dispatch<SetStateAction<string>>;
  setTaskDraft: Dispatch<SetStateAction<DesktopTaskDraft | null>>;
  t: ReturnType<typeof createTranslator>;
  taskDraft: DesktopTaskDraft | null;
};

const blockTypes: BlockType[] = ["implementation", "review"];

function acceptanceText(acceptance: string[]): string {
  return acceptance.join("\n");
}

function acceptanceItems(text: string): string[] {
  return text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function NewTaskView({
  confirmTaskDraft,
  generateTaskDraft,
  graph,
  handleOpenProject,
  newTaskMode,
  newTaskTargetId,
  newTaskText,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setNewTaskMode,
  setNewTaskTargetId,
  setNewTaskText,
  setTaskDraft,
  t,
  taskDraft
}: NewTaskViewProps) {
  const hasProject = Boolean(selectedProject);
  const draftTaskKeys = useRef<string[]>([]);
  const draftBlockKeys = useRef<string[]>([]);
  syncDraftItemKeys(draftTaskKeys.current, taskDraft?.tasks.length ?? 0, "draft-task");
  syncDraftItemKeys(draftBlockKeys.current, taskDraft?.blocks.length ?? 0, "draft-block");
  const keyedDraftTasks = pairDraftItems(taskDraft?.tasks ?? [], draftTaskKeys.current);
  const keyedDraftBlocks = pairDraftItems(taskDraft?.blocks ?? [], draftBlockKeys.current);
  const updateTaskDraftTask = (
    taskIndex: number,
    patch: Partial<DesktopTaskDraft["tasks"][number]>
  ) => {
    setTaskDraft((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((task, index) =>
              index === taskIndex ? { ...task, ...patch } : task
            )
          }
        : current
    );
  };
  const updateTaskDraftBlock = (
    blockIndex: number,
    patch: Partial<DesktopTaskDraft["blocks"][number]>
  ) => {
    setTaskDraft((current) =>
      current
        ? {
            ...current,
            blocks: current.blocks.map((block, index) =>
              index === blockIndex ? { ...block, ...patch } : block
            )
          }
        : current
    );
  };
  const targetCanvasName =
    selectedProject?.taskCanvases.find((canvas) => canvas.canvasId === selectedCanvasId)?.name ??
    selectedProject?.taskCanvases.find(
      (canvas) => canvas.canvasId === selectedProject.activeCanvasId
    )?.name ??
    selectedProject?.taskCanvases[0]?.name ??
    selectedProject?.name ??
    t("noProject");
  const draftTaskCount = taskDraft?.tasks.length ?? 0;
  const draftBlockCount =
    (taskDraft?.blocks.length ?? 0) +
    (taskDraft?.tasks.reduce((sum, task) => sum + task.blockTypes.length, 0) ?? 0);
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-4">
      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>{t("authoring")}</CardTitle>
          <CardDescription>
            {hasProject ? t("taskInputHint") : t("newTaskNoProjectHint")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel>{t("creationMode")}</FieldLabel>
              <Select
                value={newTaskMode}
                onValueChange={(value) => setNewTaskMode(value as DesktopTaskDraftMode)}
              >
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
              <Textarea
                data-testid="new-task-input"
                className="min-h-64 resize-none"
                value={newTaskText}
                onChange={(event) => setNewTaskText(event.target.value)}
              />
              <FieldDescription>{t("taskInputHint")}</FieldDescription>
            </Field>
            <div className="flex gap-2">
              <Button
                data-testid="new-task-generate-draft"
                disabled={!hasProject || !newTaskText.trim()}
                onClick={() => void generateTaskDraft()}
              >
                {t("generateDraft")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void (hasProject ? setActiveView("graph") : handleOpenProject())}
              >
                {hasProject ? t("skipToCanvas") : t("openProject")}
              </Button>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>
      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>{t("draftPreview")}</CardTitle>
          <CardDescription>
            {targetCanvasName} · {t("taskCount")}: {draftTaskCount} · {t("blockCount")}:{" "}
            {draftBlockCount}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-col gap-3">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 pr-2">
              {keyedDraftTasks.map(({ item: task, key }, index) => (
                <div className="flex flex-col gap-2 rounded-lg border p-3" key={key}>
                  <Field>
                    <FieldLabel>{t("taskTitle")}</FieldLabel>
                    <Input
                      value={task.title}
                      onChange={(event) =>
                        updateTaskDraftTask(index, { title: event.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t("acceptance")}</FieldLabel>
                    <Textarea
                      className="min-h-20 resize-y"
                      value={acceptanceText(task.acceptance)}
                      onChange={(event) =>
                        updateTaskDraftTask(index, {
                          acceptance: acceptanceItems(event.target.value)
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t("blocks")}</FieldLabel>
                    <div className="flex flex-wrap gap-2">
                      {blockTypes.map((type) => (
                        <Button
                          key={type}
                          size="sm"
                          type="button"
                          variant={task.blockTypes.includes(type) ? "default" : "outline"}
                          onClick={() =>
                            updateTaskDraftTask(index, {
                              blockTypes: task.blockTypes.includes(type)
                                ? task.blockTypes.filter((blockType) => blockType !== type)
                                : [...task.blockTypes, type]
                            })
                          }
                        >
                          {type === "implementation" ? t("implementationBlock") : t("reviewBlock")}
                        </Button>
                      ))}
                    </div>
                  </Field>
                  <Field>
                    <FieldLabel>{t("taskPrompt")}</FieldLabel>
                    <Textarea
                      className="min-h-28 resize-y"
                      value={task.promptMarkdown}
                      onChange={(event) =>
                        updateTaskDraftTask(index, { promptMarkdown: event.target.value })
                      }
                    />
                  </Field>
                </div>
              ))}
              {keyedDraftBlocks.map(({ item: block, key }, index) => (
                <div className="flex flex-col gap-2 rounded-lg border p-3" key={key}>
                  <Field>
                    <FieldLabel>{t("blockTitle")}</FieldLabel>
                    <Input
                      value={block.title}
                      onChange={(event) =>
                        updateTaskDraftBlock(index, { title: event.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t("targetTask")}</FieldLabel>
                    <Select
                      value={block.taskId}
                      onValueChange={(value) => updateTaskDraftBlock(index, { taskId: value })}
                    >
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
                  <Field>
                    <FieldLabel>{t("blockType")}</FieldLabel>
                    <Select
                      value={block.type}
                      onValueChange={(value) =>
                        updateTaskDraftBlock(index, { type: value as BlockType })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {blockTypes.map((type) => (
                            <SelectItem value={type} key={type}>
                              {type === "implementation"
                                ? t("implementationBlock")
                                : t("reviewBlock")}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>{t("blockPrompt")}</FieldLabel>
                    <Textarea
                      className="min-h-28 resize-y"
                      value={block.promptMarkdown}
                      onChange={(event) =>
                        updateTaskDraftBlock(index, { promptMarkdown: event.target.value })
                      }
                    />
                  </Field>
                </div>
              ))}
            </div>
          </ScrollArea>
          <Button
            data-testid="new-task-confirm-write"
            disabled={!hasProject || !taskDraft}
            onClick={() => void confirmTaskDraft()}
          >
            {t("confirmWrite")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
