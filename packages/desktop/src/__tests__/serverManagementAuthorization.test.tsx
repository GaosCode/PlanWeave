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
  revokeManagementDevice: vi.fn(),
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const t = createTranslator("zh-CN");
function Authorization({ origin = "https://one.example" }: { origin?: string }) {
  return (
    <ServerManagementAuthorization serverOrigin={origin} t={t}>
      {(access) => (
        <>
          <span>{access.label}</span>
          <button type="button" disabled={access.disabled} onClick={access.open}>
            {t("serverManagementDetails")}
          </button>
        </>
      )}
    </ServerManagementAuthorization>
  );
}
const load = async (origin = "https://one.example") => {
  await act(async () => {
    render(<Authorization origin={origin} />);
  });
  const action = screen.getByRole("button", { name: t("serverManagementDetails") });
  await waitFor(() => expect(action).toBeEnabled());
  await userEvent.click(action);
  await screen.findByRole("dialog");
};

it("makes reauthorization primary and imports only to the selected Server under advanced options", async () => {
  await load("https://two.example");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText(t("serverManagementAdvanced")));
  api.getManagementAuthorization.mockResolvedValue({ ...ready, profileId: "two" });
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementImport") }));
  expect(await screen.findByText(t("serverManagementVerified"))).toBeInTheDocument();
  expect(api.importOperatorCredential).toHaveBeenCalledWith({
    profileId: "two",
    verifyBeforeSave: true
  });
});

it("shows device access status without a routine renewal action", async () => {
  api.getManagementAuthorization.mockResolvedValue(ready);
  await load();
  expect(screen.getByText(t("serverManagementAdministrator"))).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: t("serverManagementReauthorize") })
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/有效期至/)).not.toBeInTheDocument();
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
  expect(screen.queryByLabelText(t("serverManagementRecoveryCode"))).not.toBeInTheDocument();
});

it("does not claim persistent recovery with session-only credential storage", async () => {
  await load();
  api.getOperatorControlStatus.mockResolvedValue({
    ...status,
    profiles: status.profiles.map((p) => ({ ...p, operatorCredentialPersistence: "session-only" }))
  });
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  expect((await screen.findAllByText(t("serverManagementSessionOnly"))).length).toBeGreaterThan(0);
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
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
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
  expect(
    screen.queryByRole("button", { name: t("serverManagementReauthorize") })
  ).not.toBeInTheDocument();
  expect(screen.getByText(t("serverManagementAdministrator"))).toBeInTheDocument();
});

it("keeps recovery commands out of the default page", async () => {
  api.getManagementAuthorization.mockResolvedValue(ready);
  render(<Authorization />);
  expect(await screen.findByText(t("serverManagementAdministrator"))).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(/docker compose exec/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(t("serverManagementRecoveryCode"))).not.toBeInTheDocument();
});

it("requires explicit confirmation before revoking a device", async () => {
  const deviceId = "c28d8f73-0881-4a71-b21d-2a69f223aabc";
  api.getManagementAuthorization.mockResolvedValue({
    ...ready,
    deviceId,
    devices: [
      {
        deviceId,
        deviceName: "My Mac",
        operatorId: "admin",
        createdAt: "2030-01-01T00:00:00Z",
        lastUsedAt: "2030-01-01T00:00:00Z",
        revokedAt: null
      }
    ]
  });
  api.revokeManagementDevice.mockResolvedValue({
    profileId: "one",
    authorization: null,
    errorCode: "operator_device_revoked"
  });
  await load();
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementRevoke") }));
  expect(api.revokeManagementDevice).not.toHaveBeenCalled();
  await userEvent.click(screen.getAllByRole("button", { name: t("serverManagementRevoke") })[1]);
  expect(api.revokeManagementDevice).toHaveBeenCalledWith({ profileId: "one", deviceId });
  expect(await screen.findByText(t("serverManagementDeviceRevoked"))).toBeVisible();
});

it("does not describe a network failure as lost authorization", async () => {
  api.getManagementAuthorization.mockResolvedValue({
    profileId: "one",
    authorization: null,
    errorCode: "operator_offline"
  });
  render(<Authorization />);
  expect(await screen.findByText(t("serverManagementUnavailable"))).toBeVisible();
  expect(screen.queryByText(t("serverManagementNeedsRecovery"))).not.toBeInTheDocument();
});

it("does not claim success when imported credentials fail the management check", async () => {
  await load();
  api.getManagementAuthorization.mockResolvedValue({
    profileId: "one",
    authorization: null,
    errorCode: "operator_device_revoked"
  });
  await userEvent.click(screen.getByText(t("serverManagementAdvanced")));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementImport") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(t("serverManagementDeviceRevoked"));
  expect(screen.queryByText(t("serverManagementVerified"))).not.toBeInTheDocument();
});

it("clears a previous transport error after automatic rechecking succeeds", async () => {
  await load();
  api.reauthorizeManagement.mockRejectedValueOnce(new Error("operator_management_failed"));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(t("serverManagementFailed"));
  api.getManagementAuthorization.mockResolvedValue(ready);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  // Remount establishes the polling timer under the controlled clock.
  cleanup();
  api.getManagementAuthorization.mockRejectedValueOnce(new Error("operator_management_failed"));
  render(<Authorization />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
  });
  expect(screen.getByText(t("serverManagementAdministrator"))).toBeInTheDocument();
  vi.useRealTimers();
});

it("does not reuse the active administrator from another Server", async () => {
  render(<Authorization origin="https://unknown.example" />);
  await waitFor(() => expect(api.getOperatorControlStatus).toHaveBeenCalled());
  expect(api.getManagementAuthorization).not.toHaveBeenCalled();
  expect(screen.getByRole("button")).toBeDisabled();
});
it("offers only administrator identities from the same Server", async () => {
  api.getOperatorControlStatus.mockResolvedValue({
    ...status,
    profiles: [
      ...status.profiles,
      { ...status.profiles[0], profileId: "alternate", operatorId: "other-admin" }
    ]
  });
  await load();
  expect(screen.queryByRole("option", { name: /two.example/ })).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole("combobox"), "alternate");
  await waitFor(() =>
    expect(api.getManagementAuthorization).toHaveBeenLastCalledWith({ profileId: "alternate" })
  );
});
