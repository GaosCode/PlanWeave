import { useLayoutEffect, useRef, useState } from "react";
import type {
  DesktopProjectSummary,
  ProjectDoctorIssue,
  ProjectDoctorReport
} from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";

type SettingsProjectDoctorSectionProps = {
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

type ProjectDoctorOperation = {
  kind: "check" | "repair";
  projectId: string;
  requestId: number;
} | null;

type ProjectDoctorReportForProject = {
  projectId: string;
  report: ProjectDoctorReport;
};

function reportIssues(report: ProjectDoctorReport): ProjectDoctorIssue[] {
  return [...report.errors, ...report.warnings];
}

function DoctorIssueList({ issues }: { issues: ProjectDoctorIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {issues.map((issue, index) => (
        <li
          className="rounded-md border border-border/80 bg-surface-raised px-3 py-2 text-sm"
          key={`${issue.canvasId ?? "project"}:${issue.code}:${issue.path ?? index}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={issue.repaired ? "secondary" : "destructive"}>{issue.code}</Badge>
            {issue.canvasId ? (
              <span className="text-xs text-text-muted">{issue.canvasId}</span>
            ) : null}
            {issue.path ? <code className="text-xs text-text-muted">{issue.path}</code> : null}
          </div>
          <p className="mt-1 text-text-muted">{issue.message}</p>
        </li>
      ))}
    </ul>
  );
}

export function SettingsProjectDoctorSection({
  selectedProject,
  setError,
  t
}: SettingsProjectDoctorSectionProps) {
  const [operation, setOperation] = useState<ProjectDoctorOperation>(null);
  const [reportForProject, setReportForProject] = useState<ProjectDoctorReportForProject | null>(
    null
  );
  const [failure, setFailure] = useState<string | null>(null);
  const selectedProjectId = selectedProject?.projectId ?? null;
  const currentProjectIdRef = useRef<string | null>(selectedProjectId);
  const requestSequence = useRef(0);
  currentProjectIdRef.current = selectedProjectId;
  const projectReference = selectedProjectId ? { projectId: selectedProjectId } : null;
  const report = reportForProject?.projectId === selectedProjectId ? reportForProject.report : null;
  const currentOperation = operation?.projectId === selectedProjectId ? operation.kind : null;
  const unavailable = !projectReference || !bridge;

  useLayoutEffect(() => {
    if (currentProjectIdRef.current !== selectedProjectId) return;
    setOperation(null);
    setReportForProject(null);
    setFailure(null);
    setError(null);
    return () => {
      requestSequence.current += 1;
    };
  }, [selectedProjectId, setError]);

  const requestIsCurrent = (requestId: number, projectId: string) =>
    requestSequence.current === requestId && currentProjectIdRef.current === projectId;

  const runCheck = async () => {
    if (!projectReference || !bridge) return;
    const { projectId } = projectReference;
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    setOperation({ kind: "check", projectId, requestId });
    setReportForProject(null);
    setFailure(null);
    setError(null);
    try {
      const nextReport = await bridge.checkProjectDoctor({ projectId });
      if (requestIsCurrent(requestId, projectId)) {
        setReportForProject({ projectId, report: nextReport });
      }
    } catch (error) {
      if (!requestIsCurrent(requestId, projectId)) return;
      const message = error instanceof Error ? error.message : String(error);
      setFailure(message);
      setError(message);
    } finally {
      if (requestIsCurrent(requestId, projectId)) setOperation(null);
    }
  };

  const runRepair = async () => {
    if (!projectReference || !bridge || !report) return;
    if (!window.confirm(t("projectDoctorRepairConfirm"))) return;
    const { projectId } = projectReference;
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    setOperation({ kind: "repair", projectId, requestId });
    setFailure(null);
    setError(null);
    try {
      const nextReport = await bridge.repairProjectDoctor(
        { projectId },
        {
          confirmation: "repair_project_runtime_drift"
        }
      );
      if (requestIsCurrent(requestId, projectId)) {
        setReportForProject({ projectId, report: nextReport });
      }
    } catch (error) {
      if (!requestIsCurrent(requestId, projectId)) return;
      const message = error instanceof Error ? error.message : String(error);
      setFailure(message);
      setError(message);
    } finally {
      if (requestIsCurrent(requestId, projectId)) setOperation(null);
    }
  };

  const issues = report ? reportIssues(report) : [];

  return (
    <section data-testid="settings-section-project-doctor" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
          {t("settingsProjectDoctor")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{t("settingsProjectDoctorHint")}</p>
      </div>

      {!selectedProject ? (
        <p className="text-sm text-text-muted">{t("projectDoctorNoProject")}</p>
      ) : null}
      {selectedProject && !bridge ? (
        <p className="text-sm text-destructive">{t("projectDoctorBridgeUnavailable")}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="project-doctor-check"
          disabled={unavailable || currentOperation !== null}
          onClick={() => void runCheck()}
        >
          {currentOperation === "check" ? t("projectDoctorChecking") : t("projectDoctorCheck")}
        </Button>
        <Button
          data-testid="project-doctor-repair"
          disabled={unavailable || currentOperation !== null || !report}
          variant="destructive"
          onClick={() => void runRepair()}
        >
          {currentOperation === "repair" ? t("projectDoctorRepairing") : t("projectDoctorRepair")}
        </Button>
      </div>

      {failure ? (
        <div className="rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {failure}
        </div>
      ) : null}

      {report ? (
        <div className="flex flex-col gap-4 rounded-md border border-border/80 bg-surface-raised p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={report.ok ? "secondary" : "destructive"}>
              {report.ok ? t("projectDoctorHealthy") : t("projectDoctorIssuesFound")}
            </Badge>
            <Badge variant="outline">
              {t("projectDoctorErrorCount")}: {report.errors.length}
            </Badge>
            <Badge variant="outline">
              {t("projectDoctorWarningCount")}: {report.warnings.length}
            </Badge>
            <Badge variant="outline">
              {t("projectDoctorCanvasCount")}: {report.canvasReports.length}
            </Badge>
            {report.repaired ? (
              <Badge variant="secondary">{t("projectDoctorRepaired")}</Badge>
            ) : null}
          </div>
          <DoctorIssueList issues={issues} />
          <div className="flex flex-col gap-2">
            {report.canvasReports.map((canvas) => (
              <div className="flex items-center justify-between text-sm" key={canvas.canvasId}>
                <span>{canvas.canvasId}</span>
                <span className={canvas.ok ? "text-text-muted" : "text-destructive"}>
                  {canvas.ok ? t("projectDoctorCanvasHealthy") : t("projectDoctorCanvasIssues")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
