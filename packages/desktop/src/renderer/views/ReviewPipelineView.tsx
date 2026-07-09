import type { Dispatch, SetStateAction } from "react";
import type {
  DesktopGraphViewModel,
  DesktopReviewPipeline,
  DesktopReviewPipelineStepInput
} from "@planweave-ai/runtime";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
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
import { parseNonNegativeIntegerInput } from "../hooks/reviewPipelineDraft";

export type ReviewPipelineViewProps = {
  addReviewStep: () => void;
  graph: DesktopGraphViewModel | null;
  moveReviewStep: (index: number, direction: -1 | 1) => void;
  removeReviewStep: (index: number) => void;
  reviewDefaultCyclesDraft: number;
  reviewDraft: DesktopReviewPipelineStepInput[];
  reviewPipeline: DesktopReviewPipeline | null;
  reviewTaskId: string | null;
  saveReviewPipeline: () => Promise<void>;
  setReviewDefaultCyclesDraft: Dispatch<SetStateAction<number>>;
  setReviewTaskId: Dispatch<SetStateAction<string | null>>;
  t: ReturnType<typeof createTranslator>;
  updateReviewStep: (index: number, patch: Partial<DesktopReviewPipelineStepInput>) => void;
};

export function ReviewPipelineView({
  addReviewStep,
  graph,
  moveReviewStep,
  removeReviewStep,
  reviewDefaultCyclesDraft,
  reviewDraft,
  reviewPipeline,
  reviewTaskId,
  saveReviewPipeline,
  setReviewDefaultCyclesDraft,
  setReviewTaskId,
  t,
  updateReviewStep
}: ReviewPipelineViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
            {t("reviewPipeline")}
          </h1>
          <p className="mt-1 text-sm text-text-muted">{t("settingsReviewHint")}</p>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto md:justify-end">
          <Button
            className="max-w-full min-w-0 overflow-hidden"
            variant="outline"
            onClick={addReviewStep}
          >
            <PlusIcon data-icon="inline-start" />
            {t("addReviewStep")}
          </Button>
          <Button
            className="max-w-full min-w-0 overflow-hidden"
            onClick={() => void saveReviewPipeline()}
          >
            {t("saveReviewPipeline")}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border/80 bg-surface-raised p-4 shadow-sm">
        <div className="min-w-[min(100%,16rem)] flex-1 sm:flex-none">
          <Select value={reviewTaskId ?? ""} onValueChange={setReviewTaskId}>
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue aria-label={t("targetTask")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {graph?.tasks.map((task) => (
                  <SelectItem key={task.taskId} value={task.taskId}>
                    {task.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Field className="min-w-[10rem] flex-1 sm:w-40 sm:flex-none">
          <FieldLabel>{t("packageDefaultCycles")}</FieldLabel>
          <Input
            min={0}
            type="number"
            value={reviewDefaultCyclesDraft}
            onChange={(event) =>
              setReviewDefaultCyclesDraft(parseNonNegativeIntegerInput(event.target.value))
            }
          />
        </Field>
        {reviewPipeline ? (
          <Badge className="max-w-full shrink-0" variant="outline">
            {reviewPipeline.packageDefaults.completionPolicy}
          </Badge>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 pr-3">
          {reviewDraft.map((step, index) => {
            const hook = step.hook;
            const hookArgs = hook?.args ?? [];
            return (
              <Card
                className="rounded-md border-border/80 bg-surface-raised shadow-sm"
                key={`${step.blockId || "new"}-${index}`}
              >
                <CardHeader>
                  <CardTitle className="flex min-w-0 items-center gap-2 text-base">
                    <Badge variant={step.enabled ? "secondary" : "outline"}>{index + 1}</Badge>
                    <span className="truncate">{step.title}</span>
                  </CardTitle>
                  <CardDescription>{step.blockId || t("newReviewStep")}</CardDescription>
                  <CardAction className="flex gap-1">
                    <Button
                      disabled={index === 0}
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("moveUp")}
                      onClick={() => moveReviewStep(index, -1)}
                    >
                      <ArrowUpIcon data-icon="inline-start" />
                    </Button>
                    <Button
                      disabled={index === reviewDraft.length - 1}
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("moveDown")}
                      onClick={() => moveReviewStep(index, 1)}
                    >
                      <ArrowDownIcon data-icon="inline-start" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("remove")}
                      onClick={() => removeReviewStep(index)}
                    >
                      <Trash2Icon data-icon="inline-start" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>{t("title")}</FieldLabel>
                      <Input
                        value={step.title}
                        onChange={(event) => updateReviewStep(index, { title: event.target.value })}
                      />
                    </Field>
                    <div className="grid gap-3 lg:grid-cols-3">
                      <Field>
                        <FieldLabel>{t("enabled")}</FieldLabel>
                        <Select
                          value={step.enabled ? "enabled" : "disabled"}
                          onValueChange={(value) =>
                            updateReviewStep(index, { enabled: value === "enabled" })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="enabled">{t("enabled")}</SelectItem>
                              <SelectItem value="disabled">{t("disabled")}</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>{t("preset")}</FieldLabel>
                        <Input
                          value={step.preset}
                          onChange={(event) =>
                            updateReviewStep(index, { preset: event.target.value })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>{t("maxFeedbackCycles")}</FieldLabel>
                        <Input
                          min={0}
                          type="number"
                          value={step.maxFeedbackCycles}
                          onChange={(event) =>
                            updateReviewStep(index, {
                              maxFeedbackCycles: parseNonNegativeIntegerInput(event.target.value)
                            })
                          }
                        />
                      </Field>
                    </div>
                    <Field>
                      <FieldLabel>{t("triggerCondition")}</FieldLabel>
                      <Select
                        value={step.triggerCondition}
                        onValueChange={(value) =>
                          updateReviewStep(index, {
                            triggerCondition:
                              value === "manual" ? "manual" : "after_required_work_completed"
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="after_required_work_completed">
                              {t("afterRequiredWork")}
                            </SelectItem>
                            <SelectItem value="manual">{t("manualTrigger")}</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <div className="grid gap-3 lg:grid-cols-3">
                      <Field>
                        <FieldLabel>{t("inputContext")}</FieldLabel>
                        <Textarea
                          className="min-h-24 resize-none"
                          value={step.inputContext}
                          onChange={(event) =>
                            updateReviewStep(index, { inputContext: event.target.value })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>{t("passCriteria")}</FieldLabel>
                        <Textarea
                          className="min-h-24 resize-none"
                          value={step.passCriteria}
                          onChange={(event) =>
                            updateReviewStep(index, { passCriteria: event.target.value })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>{t("feedbackFormat")}</FieldLabel>
                        <Textarea
                          className="min-h-24 resize-none"
                          value={step.feedbackFormat}
                          onChange={(event) =>
                            updateReviewStep(index, { feedbackFormat: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      <Field>
                        <FieldLabel>{t("hookCommand")}</FieldLabel>
                        <Input
                          value={step.hook?.command ?? ""}
                          onChange={(event) => {
                            const command = event.target.value.trim();
                            updateReviewStep(index, {
                              hook: command
                                ? {
                                    id:
                                      step.hook?.id ??
                                      `${step.blockId || `review-${index + 1}`}-hook`,
                                    type: "executable",
                                    command,
                                    args: step.hook?.args ?? [],
                                    executionPolicy: "trusted-local"
                                  }
                                : null
                            });
                          }}
                        />
                      </Field>
                      {hook ? (
                        <Field className="min-w-0">
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <FieldLabel>{t("hookArgs")}</FieldLabel>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("addHookArg")}
                              onClick={() =>
                                updateReviewStep(index, {
                                  hook: {
                                    ...hook,
                                    args: [...hook.args, ""]
                                  }
                                })
                              }
                            >
                              <PlusIcon data-icon="inline-start" />
                            </Button>
                          </div>
                          <div className="flex min-w-0 flex-col gap-2">
                            {hookArgs.map((arg, argIndex) => (
                              <div className="flex min-w-0 items-center gap-2" key={argIndex}>
                                <Input
                                  className="min-w-0 flex-1"
                                  aria-label={`${t("hookArg")} ${argIndex + 1}`}
                                  value={arg}
                                  onChange={(event) =>
                                    updateReviewStep(index, {
                                      hook: {
                                        ...hook,
                                        args: hook.args.map((currentArg, currentIndex) =>
                                          currentIndex === argIndex
                                            ? event.target.value
                                            : currentArg
                                        )
                                      }
                                    })
                                  }
                                />
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={t("clearHookArg")}
                                  onClick={() =>
                                    updateReviewStep(index, {
                                      hook: {
                                        ...hook,
                                        args: hook.args.map((currentArg, currentIndex) =>
                                          currentIndex === argIndex ? "" : currentArg
                                        )
                                      }
                                    })
                                  }
                                >
                                  <XIcon data-icon="inline-start" />
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={t("removeHookArg")}
                                  onClick={() =>
                                    updateReviewStep(index, {
                                      hook: {
                                        ...hook,
                                        args: hook.args.filter(
                                          (_, currentIndex) => currentIndex !== argIndex
                                        )
                                      }
                                    })
                                  }
                                >
                                  <Trash2Icon data-icon="inline-start" />
                                </Button>
                              </div>
                            ))}
                            {hookArgs.length === 0 ? (
                              <Button
                                className="w-fit max-w-full"
                                variant="outline"
                                onClick={() =>
                                  updateReviewStep(index, {
                                    hook: {
                                      ...hook,
                                      args: [""]
                                    }
                                  })
                                }
                              >
                                <PlusIcon data-icon="inline-start" />
                                {t("addHookArg")}
                              </Button>
                            ) : null}
                          </div>
                        </Field>
                      ) : null}
                    </div>
                    <Field>
                      <FieldLabel>{t("taskPrompt")}</FieldLabel>
                      <Textarea
                        className="min-h-40 resize-none"
                        value={step.promptMarkdown}
                        onChange={(event) =>
                          updateReviewStep(index, { promptMarkdown: event.target.value })
                        }
                      />
                      <FieldDescription>{t("reviewPromptHint")}</FieldDescription>
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
