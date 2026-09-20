/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerManagementAuthorization } from "../renderer/settings/ServerManagementAuthorization";
import { createTranslator } from "../renderer/i18n";

const api = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  importOperatorCredential: vi.fn(),
  getManagementAuthorization: vi.fn(),
  reauthorizeManagement: vi.fn(),
  recoverManagement: vi.fn(),
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
const ready = {
  profileId: "one",
  authorization: {
    operatorId: "admin",
    expiresAt: "2030-02-01T00:00:00Z",
    renewAfter: "2030-01-22T00:00:00Z"
  },
  errorCode: null
};
beforeEach(() => {
  vi.clearAllMocks();
  api.getOperatorControlStatus.mockResolvedValue(status);
  api.importOperatorCredential.mockResolvedValue(status);
  api.getManagementAuthorization.mockResolvedValue({
    profileId: "one",
    authorization: null,
    errorCode: null
  });
  api.reauthorizeManagement.mockResolvedValue(ready);
  api.recoverManagement.mockResolvedValue(ready);
});
afterEach(cleanup);
const t = createTranslator("zh-CN");
const load = async () => {
  await act(async () => {
    render(<ServerManagementAuthorization t={t} />);
  });
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
};

it("makes reauthorization primary and imports only to the selected Server under advanced options", async () => {
  await load();
  await userEvent.selectOptions(screen.getByRole("combobox"), "two");
  await userEvent.click(screen.getByText(t("serverManagementAdvanced")));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementImport") }));
  expect(await screen.findByText(t("serverManagementVerified"))).toBeInTheDocument();
  expect(api.importOperatorCredential).toHaveBeenCalledWith({
    profileId: "two",
    verifyBeforeSave: true
  });
});

it("shows automatic renewal expiry and completes reauthorization", async () => {
  api.getManagementAuthorization.mockResolvedValue(ready);
  await load();
  expect(screen.getByText(new RegExp(t("serverManagementAutomatic")))).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  expect(api.reauthorizeManagement).toHaveBeenCalledWith({ profileId: "one" });
  expect(await screen.findByText(t("serverManagementVerified"))).toBeInTheDocument();
});

it("opens recovery when no valid admin remains, explains invalid codes and clears successful input", async () => {
  api.reauthorizeManagement.mockRejectedValue(new Error("operator_management_recovery_required"));
  api.recoverManagement.mockRejectedValueOnce(new Error("operator_recovery_invalid"));
  await load();
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(t("serverManagementRecoveryRequired"));
  const input = screen.getByLabelText(t("serverManagementRecoveryCode"));
  expect(input).toBeVisible();
  const code = `pw_recover_${"A".repeat(43)}`;
  await userEvent.type(input, code);
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementRecover") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(t("serverManagementRecoveryInvalid"));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementRecover") }));
  expect(await screen.findByText(t("serverManagementVerified"))).toBeInTheDocument();
  expect(input).toHaveValue("");
});

it("does not claim persistent recovery with session-only credential storage", async () => {
  await load();
  api.getOperatorControlStatus.mockResolvedValue({
    ...status,
    profiles: status.profiles.map((p) => ({ ...p, operatorCredentialPersistence: "session-only" }))
  });
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  expect(await screen.findByText(t("serverManagementSessionOnly"))).toBeInTheDocument();
});

it("explains that an older Server requires an upgrade", async () => {
  api.getManagementAuthorization.mockResolvedValue({
    profileId: "one",
    authorization: null,
    errorCode: "operator_management_upgrade_required"
  });
  await load();
  expect(screen.getByRole("alert")).toHaveTextContent(t("serverManagementUpgradeRequired"));
});

it("uses endpoint identity for stale local labels and marks only desktop-owned Servers as local", async () => {
  api.getOperatorControlStatus.mockResolvedValue({
    ...status,
    profiles: status.profiles.map((p) => ({
      ...p,
      displayName: "Local collaboration server operator",
      hostedByThisDesktop: p.profileId === "two"
    }))
  });
  await load();
  expect(screen.getByRole("option", { name: /one.example/ })).not.toHaveTextContent("local");
  expect(screen.getByRole("option", { name: /two.example/ })).toHaveTextContent(
    t("serverLocalProcess")
  );
  expect(screen.queryByText(/Local collaboration server operator/)).not.toBeInTheDocument();
  expect(screen.getByTestId("management-server-identity")).toHaveTextContent(
    "https://one.example/"
  );
  expect(screen.getByTestId("management-server-identity")).toHaveTextContent("admin");
});

it("guides remote upgrades and retries without issuing credentials to an unavailable endpoint", async () => {
  api.getManagementAuthorization
    .mockResolvedValueOnce({
      profileId: "one",
      authorization: null,
      errorCode: "operator_management_upgrade_required"
    })
    .mockResolvedValue(ready);
  await load();
  expect(screen.getByRole("button", { name: t("serverManagementReauthorize") })).toBeDisabled();
  expect(screen.getByTestId("management-upgrade-guide")).toHaveTextContent(
    t("serverManagementUpgradeRemote")
  );
  expect(screen.getByTestId("management-upgrade-guide")).toHaveTextContent(
    "/api/v1/management-authorization/"
  );
  expect(api.reauthorizeManagement).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementCheckAgain") }));
  await waitFor(() =>
    expect(screen.queryByTestId("management-upgrade-guide")).not.toBeInTheDocument()
  );
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: t("serverManagementReauthorize") })).toBeEnabled();
  expect(screen.getByText(new RegExp(t("serverManagementAutomatic")))).toBeInTheDocument();
});
