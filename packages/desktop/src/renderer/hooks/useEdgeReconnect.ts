import { useCallback, useRef } from "react";
import type { Connection, Edge, FinalConnectionState } from "@xyflow/react";

type UseEdgeReconnectArgs = {
  handleEdgesDelete: (deletedEdges: Edge[]) => Promise<void>;
  handleReconnectEdge: (oldEdge: Edge, connection: Connection) => Promise<void>;
};

export function useEdgeReconnect({ handleEdgesDelete, handleReconnectEdge }: UseEdgeReconnectArgs) {
  const reconnectSucceededRef = useRef(false);

  const handleReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      reconnectSucceededRef.current = true;
      void handleReconnectEdge(oldEdge, connection);
    },
    [handleReconnectEdge]
  );

  const handleReconnectStart = useCallback(() => {
    reconnectSucceededRef.current = false;
  }, []);

  const handleReconnectEnd = useCallback(
    (
      _event: MouseEvent | TouchEvent,
      edge: Edge,
      _handleType: "source" | "target",
      connectionState: FinalConnectionState
    ) => {
      if (reconnectSucceededRef.current || connectionState.isValid) {
        return;
      }
      void handleEdgesDelete([edge]);
    },
    [handleEdgesDelete]
  );

  return {
    handleReconnect,
    handleReconnectEnd,
    handleReconnectStart
  };
}
