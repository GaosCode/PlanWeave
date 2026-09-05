import { ViewportPortal, type Edge, type Node } from "@xyflow/react";
import type { CanvasPresenceRemoteSession } from "../collaboration/WorkspaceCanvasPresenceController";
import type { createTranslator } from "../i18n";

const presenceColors = [
  { background: "#075985", foreground: "#ffffff" },
  { background: "#7c2d12", foreground: "#ffffff" },
  { background: "#166534", foreground: "#ffffff" },
  { background: "#6b21a8", foreground: "#ffffff" },
  { background: "#9a3412", foreground: "#ffffff" },
  { background: "#1e3a8a", foreground: "#ffffff" },
  { background: "#3f6212", foreground: "#ffffff" },
  { background: "#86198f", foreground: "#ffffff" }
] as const;

function colorForSession(sessionId: string) {
  let hash = 0;
  for (const character of sessionId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return presenceColors[hash % presenceColors.length];
}

function nodeSize(node: Node): { width: number; height: number } {
  return {
    width: node.measured?.width ?? node.width ?? 320,
    height: node.measured?.height ?? node.height ?? 180
  };
}

type CanvasPresenceOverlayProps = {
  sessions: CanvasPresenceRemoteSession[];
  nodes: Node[];
  edges: Edge[];
  t: ReturnType<typeof createTranslator>;
};

function format(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, String(value)),
    template
  );
}

/** Render-only remote cursors and selection outlines in ReactFlow's flow coordinate system. */
export function CanvasPresenceOverlay({ sessions, nodes, edges, t }: CanvasPresenceOverlayProps) {
  if (sessions.length === 0) return null;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeIds = new Set(edges.map((edge) => edge.id));

  return (
    <ViewportPortal>
      <section
        aria-label={t("canvasPresenceRemoteCollaborators")}
        className="pointer-events-none absolute inset-0 z-50"
        data-testid="canvas-presence-overlay"
      >
        {sessions.map((session) => {
          const color = colorForSession(session.sessionId);
          const selectedEdgeId = session.selectionIds.find((selectionId) =>
            edgeIds.has(selectionId)
          );
          const selectedEdge = selectedEdgeId
            ? edges.find((edge) => edge.id === selectedEdgeId)
            : undefined;
          const sourceNode = selectedEdge ? nodeById.get(selectedEdge.source) : undefined;
          const targetNode = selectedEdge ? nodeById.get(selectedEdge.target) : undefined;
          const edgeLeft =
            sourceNode && targetNode
              ? (sourceNode.position.x + targetNode.position.x) / 2
              : (session.pointer?.x ?? 0);
          const edgeTop =
            sourceNode && targetNode
              ? (sourceNode.position.y + targetNode.position.y) / 2
              : (session.pointer?.y ?? 0);
          return (
            <div key={session.sessionId} data-session-id={session.sessionId}>
              {session.selectionIds.map((selectionId) => {
                const node = nodeById.get(selectionId);
                if (!node) return null;
                const size = nodeSize(node);
                return (
                  <div
                    aria-label={format(t("canvasPresenceNodeSelected"), {
                      name: session.displayName,
                      id: selectionId
                    })}
                    className="absolute rounded-md border-2"
                    data-presence-selection-id={selectionId}
                    data-presence-selection-session={session.sessionId}
                    key={`${session.sessionId}:${selectionId}`}
                    role="img"
                    style={{
                      borderColor: color.background,
                      height: size.height + 8,
                      left: node.position.x - 4,
                      top: node.position.y - 4,
                      width: size.width + 8
                    }}
                  />
                );
              })}
              {session.pointer ? (
                <div
                  aria-label={
                    session.selectionIds.length > 0
                      ? format(t("canvasPresenceCursorSelected"), {
                          name: session.displayName,
                          count: session.selectionIds.length
                        })
                      : format(t("canvasPresenceCursor"), { name: session.displayName })
                  }
                  className="presence-cursor absolute"
                  data-presence-cursor="true"
                  data-presence-color={color.background}
                  role="img"
                  style={{
                    color: color.foreground,
                    transform: `translate3d(${session.pointer.x}px, ${session.pointer.y}px, 0)`
                  }}
                >
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4 drop-shadow-sm"
                    fill={color.background}
                    viewBox="0 0 16 20"
                  >
                    <path
                      d="M1 1 14.7 8.4l-5.1 1.1 3.3 6-2.2 1.2-3.3-6L4 14.8Z"
                      stroke={color.foreground}
                      strokeWidth="1"
                    />
                  </svg>
                  <span
                    className="ml-2 max-w-44 truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-4 shadow-sm"
                    style={{ backgroundColor: color.background }}
                  >
                    {session.displayName}
                    {session.selectionIds.length > 0 ? (
                      <span className="ml-1 opacity-90">· {session.selectionIds.length}</span>
                    ) : null}
                  </span>
                </div>
              ) : null}
              {selectedEdge ? (
                <span
                  aria-label={format(t("canvasPresenceEdgesSelected"), {
                    name: session.displayName
                  })}
                  className="absolute rounded px-1.5 py-0.5 text-[11px] font-medium shadow-sm"
                  data-presence-edge-selection="true"
                  role="img"
                  style={{
                    backgroundColor: color.background,
                    color: color.foreground,
                    left: edgeLeft,
                    top: edgeTop
                  }}
                >
                  {session.displayName} · {session.selectionIds.length}
                </span>
              ) : null}
            </div>
          );
        })}
      </section>
    </ViewportPortal>
  );
}
