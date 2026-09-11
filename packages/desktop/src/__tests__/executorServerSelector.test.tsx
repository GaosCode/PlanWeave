/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperatorProfileView } from "../shared/operatorControl";
import { ExecutorServerSelector } from "../renderer/executors/ExecutorServerSelector";
import { createTranslator } from "../renderer/i18n";

const local: OperatorProfileView = {
  profileId: "local",
  displayName: "PlanWeave local server",
  serverBaseUrl: "https://mac.example/",
  hostedByThisDesktop: true,
  allowInsecureTransport: false,
  operatorId: "operator-local",
  humanPrincipalId: "human",
  hasOperatorCredential: true,
  operatorCredentialPersistence: "persisted",
  updatedAt: "2030-01-01T00:00:00.000Z"
};
const remote: OperatorProfileView = {
  ...local,
  profileId: "vps",
  displayName: "Local collaboration server operator",
  serverBaseUrl: "https://vm-0-3-ubuntu.example:8443/",
  hostedByThisDesktop: false
};
beforeEach(() => {
  for (const name of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView"
  ]) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: vi.fn(() => false)
    });
  }
});
afterEach(cleanup);
it("identifies a migrated VPS by its endpoint instead of its stale local profile name", async () => {
  const onSelect = vi.fn().mockResolvedValue(true);
  render(
    <ExecutorServerSelector
      profiles={[local, remote]}
      activeProfile={remote}
      busy={false}
      onSelect={onSelect}
      t={createTranslator("en")}
    />
  );
  const trigger = screen.getByRole("combobox", { name: "Executor Server" });
  expect(trigger).toHaveTextContent("vm-0-3-ubuntu.example:8443");
  expect(trigger).not.toHaveTextContent("Local collaboration server operator");
  await userEvent.click(trigger);
  expect(screen.getByRole("option", { name: /vm-0-3-ubuntu.example/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await userEvent.click(screen.getByRole("option", { name: /Server on this computer/ }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("local");
});
it("does not reconnect the current Server when its menu entry is chosen", async () => {
  const onSelect = vi.fn().mockResolvedValue(true);
  render(
    <ExecutorServerSelector
      profiles={[local, remote]}
      activeProfile={remote}
      busy={false}
      onSelect={onSelect}
      t={createTranslator("en")}
    />
  );
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(screen.getByRole("option", { name: /vm-0-3-ubuntu.example/ }));
  expect(onSelect).not.toHaveBeenCalled();
});
it("does not infer local ownership from a loopback-looking endpoint", () => {
  render(
    <ExecutorServerSelector
      profiles={[{ ...remote, serverBaseUrl: "http://127.0.0.1:8000/" }]}
      activeProfile={{ ...remote, serverBaseUrl: "http://127.0.0.1:8000/" }}
      busy={false}
      onSelect={vi.fn()}
      t={createTranslator("en")}
    />
  );
  expect(screen.getByRole("combobox")).not.toHaveTextContent("Server on this computer");
});
