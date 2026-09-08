import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  captureIdSchema,
  type CaptureTrace,
  type CollaborationCaptureApi
} from "../../shared/collaborationCapture.js";
import { useCollaborationCapture } from "../hooks/useCollaborationCapture.js";

const COPY = {
  zh: {
    title: "协作性能采集",
    mainLoop: "主进程定时器延迟 P95",
    server: "Server 处理耗时 P95",
    serverHint: "Server 耗时需两端新版客户端与新版 Server；未采到不代表耗时为零。",
    hint: "两台设备打开同一画布，填写相同采集编号并分别开始。轮流连续移动光标，结束后各导出一份报告。",
    id: "采集编号",
    start: "开始采集",
    stop: "停止采集",
    export: "导出 JSON",
    saved: "报告已保存",
    progress: "正在采集",
    complete: "采集已结束",
    note: "最多 60 秒，仅本机采集。记录时间与数量，不包含坐标、任务正文或凭据。",
    missing: "采集接口不可用，请更新并重启此客户端。",
    startError: "未能开始采集。请确认共享画布已连接，编号只含字母、数字或连字符。",
    stopError: "未能取得完整报告，请重试停止采集。",
    exportError: "报告保存失败，请重试导出。",
    input: "鼠标输入",
    sent: "发送更新",
    received: "接收更新",
    frame: "帧间隔 P95",
    empty: "未采到",
    caveat: "消息间隔包含停手时间，不等于网络延迟；帧间隔仅统计前台页面。"
  },
  en: {
    title: "Collaboration capture",
    mainLoop: "Main timer delay P95",
    server: "Server processing P95",
    serverHint:
      "Server timing requires updated clients and Server. Missing samples do not mean zero latency.",
    hint: "Open the same canvas on both devices, enter the same capture ID and start on each. Take turns moving the cursor continuously, then export both reports.",
    id: "Capture ID",
    start: "Start capture",
    stop: "Stop capture",
    export: "Export JSON",
    saved: "Report saved",
    progress: "Recording",
    complete: "Capture finished",
    note: "Up to 60 seconds, local only. Records timing and counts, without coordinates, task text or credentials.",
    missing: "Capture is unavailable. Update and restart this client.",
    startError:
      "Could not start. Check the shared canvas connection and use only letters, digits or hyphens in the ID.",
    stopError: "Could not obtain the complete report. Retry stopping.",
    exportError: "Could not save the report. Retry exporting.",
    input: "Pointer input",
    sent: "Sent updates",
    received: "Received updates",
    frame: "Frame interval P95",
    empty: "No samples",
    caveat:
      "Message intervals include pauses in input, not just network delay. Frame intervals cover the visible page only."
  }
} as const;

function count(trace: CaptureTrace, stage: string): number {
  return trace.samples.filter((sample) => sample.stage === stage).length;
}

function durationP95(trace: CaptureTrace, stage: string): string | null {
  const values = trace.samples
    .flatMap((sample) =>
      sample.stage === stage && sample.durationMs !== undefined ? [sample.durationMs] : []
    )
    .sort((a, b) => a - b);
  return values.length ? `${values[Math.ceil(values.length * 0.95) - 1].toFixed(1)} ms` : null;
}

export function CollaborationCapturePanel({
  api,
  language
}: {
  api?: CollaborationCaptureApi;
  language: "zh" | "en";
}) {
  const copy = COPY[language];
  const capture = useCollaborationCapture(api);
  const [captureId, setCaptureId] = useState(() => crypto.randomUUID().slice(0, 8));
  const [saved, setSaved] = useState(false);
  const active = capture.phase === "running" || capture.phase === "stop_failed";
  const pending = capture.phase === "starting" || capture.phase === "stopping";
  const frames =
    capture.result?.renderer.samples
      .filter((s) => s.stage === "frame" && s.durationMs !== undefined)
      .map((s) => s.durationMs!)
      .sort((a, b) => a - b) ?? [];
  return (
    <section
      className="space-y-3 border-t border-border pt-3 font-sans text-xs"
      data-testid="collaboration-capture"
    >
      <div className="font-medium text-text-strong">{copy.title}</div>
      <p className="leading-relaxed">{copy.hint}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1">
          {copy.id}
          <input
            className="h-8 w-36 rounded-md border border-border bg-surface px-2 font-mono text-text-strong"
            value={captureId}
            disabled={active || pending}
            maxLength={48}
            onChange={(e) => {
              setCaptureId(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        {active ? (
          <Button size="sm" variant="outline" onClick={() => void capture.stop()}>
            {copy.stop}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={
              pending || !capture.available || !captureIdSchema.safeParse(captureId).success
            }
            onClick={() => {
              setSaved(false);
              void capture.start(captureId);
            }}
          >
            {copy.start}
          </Button>
        )}
        {capture.result && !active && !pending && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void capture.exportResult().then(setSaved);
            }}
          >
            {copy.export}
          </Button>
        )}
        <span role="status" className="tabular-nums">
          {capture.phase === "running"
            ? `${copy.progress} · ${Math.floor(capture.elapsed / 1000)}s`
            : saved
              ? copy.saved
              : capture.result
                ? copy.complete
                : null}
        </span>
      </div>
      {!capture.available && <p>{copy.missing}</p>}
      {capture.error && (
        <p role="alert" className="text-destructive">
          {copy[`${capture.error}Error`]}
        </p>
      )}
      {capture.result && (
        <dl className="grid grid-cols-2 gap-2 rounded-md bg-app-canvas p-3">
          <dt>{copy.mainLoop}</dt>
          <dd>{durationP95(capture.result.transport, "main_event_loop_delay") ?? copy.empty}</dd>
          <dt>{copy.server}</dt>
          <dd>{durationP95(capture.result.transport, "server_processing") ?? copy.empty}</dd>
          <dt>{copy.input}</dt>
          <dd>{count(capture.result.renderer, "pointer_input") || copy.empty}</dd>
          <dt>{copy.sent}</dt>
          <dd>{count(capture.result.transport, "socket_send") || copy.empty}</dd>
          <dt>{copy.received}</dt>
          <dd>{count(capture.result.transport, "socket_receive") || copy.empty}</dd>
          <dt>{copy.frame}</dt>
          <dd>
            {frames.length
              ? `${frames[Math.ceil(frames.length * 0.95) - 1].toFixed(1)} ms`
              : copy.empty}
          </dd>
        </dl>
      )}
      <p className="leading-relaxed">
        {copy.note} {copy.caveat} {copy.serverHint}
      </p>
    </section>
  );
}
