/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerManagementAuthorization } from "../renderer/settings/ServerManagementAuthorization";
import { createTranslator } from "../renderer/i18n";

const api = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  importOperatorCredential: vi.fn(),
  onOperatorControlStatusChanged: vi.fn(() => () => undefined)
}));
vi.mock("../renderer/bridge", () => ({ operatorControlBridge: api }));
const status = {
  activeProfileId: "one",
  profiles: ["one", "two"].map((profileId) => ({
    profileId,
    displayName: profileId,
    serverBaseUrl: `https://${profileId}.example/`,
    operatorId: "admin",
    operatorCredentialPersistence: "persisted"
  }))
};
beforeEach(() => {
  vi.clearAllMocks();
  api.getOperatorControlStatus.mockResolvedValue(status);
  api.importOperatorCredential.mockResolvedValue(status);
});
afterEach(cleanup);
const t = createTranslator("zh-CN");

it("imports only into the selected Server and requests verification without exposing the token", async () => {
  render(<ServerManagementAuthorization t={t} />);
  await userEvent.selectOptions(await screen.findByRole("combobox"), "two");
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementImport") }));
  expect(await screen.findByRole("status")).toHaveTextContent(t("serverManagementVerified"));
  expect(api.importOperatorCredential).toHaveBeenCalledWith({
    profileId: "two",
    verifyBeforeSave: true
  });
});

it("shows invalid authorization without claiming success and permits retry", async () => {
  api.importOperatorCredential.mockRejectedValueOnce(
    new Error("operator_unauthorized (server revision)")
  );
  render(<ServerManagementAuthorization t={t} />);
  await screen.findByRole("combobox");
  await userEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveTextContent(t("hostAdminUnauthorized"));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("status")).toHaveTextContent(t("serverManagementVerified"));
});

it("does not claim persistent recovery when credential storage is session-only", async () => {
  api.importOperatorCredential.mockResolvedValue({
    ...status,
    profiles: status.profiles.map((p) => ({ ...p, operatorCredentialPersistence: "session-only" }))
  });
  render(<ServerManagementAuthorization t={t} />);
  await screen.findByRole("combobox");
  await userEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("status")).toHaveTextContent(t("serverManagementSessionOnly"));
});
