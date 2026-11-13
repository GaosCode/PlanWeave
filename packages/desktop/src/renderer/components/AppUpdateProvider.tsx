import { createContext, useContext, type ReactNode } from "react";
import { useAppUpdateController } from "../hooks/useAppUpdate";

const AppUpdateContext = createContext<ReturnType<typeof useAppUpdateController> | null>(null);

export function useAppUpdate() {
  return useContext(AppUpdateContext);
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const appUpdate = useAppUpdateController();
  return <AppUpdateContext value={appUpdate}>{children}</AppUpdateContext>;
}
