/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerManagementAuthorization } from "../renderer/settings/ServerManagementAuthorization";
import { useOperatorControlStatusSnapshot } from "../renderer/hooks/useOperatorControlStatusSnapshot";
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
    hasOperatorCredential: true,
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
let statusChanged: (next: typeof status) => void;
beforeEach(() => {
  vi.resetAllMocks();
  api.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusChanged = listener;
    return () => undefined;
  });
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

it("does not let a late initial status replace a newer status event", async () => {
  const initial = deferred<typeof status>();
  api.getOperatorControlStatus.mockReturnValue(initial.promise);
  render(<Authorization />);
  await act(async () => {
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], operatorId: "new-admin" }]
    });
  });
  await waitFor(() =>
    expect(api.getManagementAuthorization).toHaveBeenCalledWith({ profileId: "one" })
  );
  await act(async () => initial.resolve(status));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementDetails") }));
  expect(screen.getByTestId("management-server-identity")).toHaveTextContent("new-admin");
});

it("does not roll back the operator identity on an older status event", async () => {
  const initial = { ...status, updatedAt: "2030-01-01T00:00:00.001Z" };
  api.getOperatorControlStatus.mockResolvedValue(initial);
  await load();
  const newer = {
    ...initial,
    updatedAt: "2030-01-01T00:00:00.003Z",
    profiles: [{ ...status.profiles[0], operatorId: "new-admin" }]
  };
  await act(async () => statusChanged(newer));
  await act(async () => statusChanged({ ...initial, updatedAt: "2030-01-01T00:00:00.002Z" }));
  expect(screen.getByTestId("management-server-identity")).toHaveTextContent("new-admin");
  expect(api.getOperatorControlStatus).toHaveBeenCalledTimes(1);
});

it("checks the authoritative status when same-timestamp events disagree", async () => {
  const initial = { ...status, updatedAt: "2030-01-01T00:00:00.001Z" };
  api.getOperatorControlStatus.mockResolvedValue(initial);
  await load();
  const latest = {
    ...initial,
    updatedAt: "2030-01-01T00:00:00.002Z",
    profiles: [{ ...status.profiles[0], operatorId: "latest-admin" }]
  };
  api.getOperatorControlStatus.mockResolvedValue(latest);
  await act(async () => statusChanged({ ...latest, updatedAt: initial.updatedAt }));
  await waitFor(() =>
    expect(screen.getByTestId("management-server-identity")).toHaveTextContent("latest-admin")
  );
  expect(api.getOperatorControlStatus).toHaveBeenCalledTimes(2);
});

it("does not verify an old import after the same profile loses its credential", async () => {
  await load();
  const imported = deferred<typeof status>();
  api.importOperatorCredential.mockReturnValue(imported.promise);
  await userEvent.click(screen.getByText(t("serverManagementAdvanced")));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementImport") }));
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], hasOperatorCredential: false }]
    })
  );
  api.getManagementAuthorization.mockResolvedValue(ready);
  await act(async () => imported.resolve(status));
  expect(screen.queryByText(t("serverManagementVerified"))).not.toBeInTheDocument();
  expect(screen.getByTestId("management-server-identity")).toHaveTextContent("admin");
});

it("keeps an import success when its own status event arrives before the response", async () => {
  await load();
  const imported = deferred<typeof status>();
  api.importOperatorCredential.mockReturnValue(imported.promise);
  await userEvent.click(screen.getByText(t("serverManagementAdvanced")));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementImport") }));
  const next = {
    ...status,
    profiles: [{ ...status.profiles[0], credentialRevision: "imported" }]
  };
  api.getManagementAuthorization.mockResolvedValue(ready);
  await act(async () => statusChanged(next));
  await act(async () => imported.resolve(next));
  expect(await screen.findByText(t("serverManagementVerified"))).toBeInTheDocument();
  expect(api.getOperatorControlStatus).toHaveBeenCalledTimes(1);
});

it("hides authorization and devices as soon as the same profile loses its credential", async () => {
  api.getManagementAuthorization.mockResolvedValue({
    ...ready,
    devices: [
      {
        deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc",
        deviceName: "Old Mac",
        operatorId: "admin",
        createdAt: "2030-01-01T00:00:00Z",
        lastUsedAt: "2030-01-01T00:00:00Z",
        revokedAt: null
      }
    ]
  });
  await load();
  expect(screen.getByText("Old Mac")).toBeInTheDocument();
  await act(async () => {
    statusChanged({
      ...status,
      profiles: [
        {
          ...status.profiles[0],
          hasOperatorCredential: false,
          operatorCredentialPersistence: "missing"
        }
      ]
    });
  });
  expect(screen.queryByText("Old Mac")).not.toBeInTheDocument();
  expect(screen.queryByText(t("serverManagementDeviceRemembered"))).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: t("serverManagementReauthorize") })
  ).toBeInTheDocument();
});

it("does not restore an old device from a check started before credential clearing", async () => {
  const oldCheck = deferred<typeof ready>();
  api.getManagementAuthorization
    .mockResolvedValueOnce({
      profileId: "one",
      authorization: null,
      errorCode: "operator_offline"
    })
    .mockReturnValueOnce(oldCheck.promise)
    .mockResolvedValueOnce({
      profileId: "one",
      authorization: null,
      errorCode: "operator_credential_missing"
    });
  await load();
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementCheckAgain") }));
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [
        {
          ...status.profiles[0],
          hasOperatorCredential: false,
          operatorCredentialPersistence: "missing"
        }
      ]
    })
  );
  await act(async () =>
    oldCheck.resolve({
      ...ready,
      devices: [
        {
          deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc",
          deviceName: "Old Mac",
          operatorId: "admin",
          createdAt: "2030-01-01T00:00:00Z",
          lastUsedAt: "2030-01-01T00:00:00Z",
          revokedAt: null
        }
      ]
    })
  );
  expect(screen.queryByText("Old Mac")).not.toBeInTheDocument();
  expect(screen.queryByText(t("serverManagementAdministrator"))).not.toBeInTheDocument();
  expect(screen.getByText(t("serverManagementNeedsRecovery"))).toBeInTheDocument();
});

it("invalidates the old authorization for replacement credentials and A to B to A changes", async () => {
  api.getManagementAuthorization.mockResolvedValue(ready);
  await load();
  expect(screen.getByText(t("serverManagementAdministrator"))).toBeInTheDocument();
  api.getManagementAuthorization.mockReturnValue(deferred<typeof ready>().promise);
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], credentialRevision: "new-revision" }]
    })
  );
  expect(screen.queryByText(t("serverManagementDeviceRemembered"))).not.toBeInTheDocument();
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], operatorId: "other-admin", credentialRevision: "b" }]
    })
  );
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], credentialRevision: "a-again" }]
    })
  );
  expect(screen.queryByText(t("serverManagementAdministrator"))).not.toBeInTheDocument();
});

it("drops old management data when the selected origin changes", async () => {
  api.getManagementAuthorization.mockResolvedValue(ready);
  const view = render(<Authorization />);
  expect(await screen.findByText(t("serverManagementAdministrator"))).toBeInTheDocument();
  view.rerender(<Authorization origin="https://two.example" />);
  expect(screen.queryByText(t("serverManagementAdministrator"))).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: t("serverManagementDetails") })).toBeEnabled()
  );
});

it("keeps the latest polling response when an older manual refresh fails", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  api.getManagementAuthorization.mockResolvedValueOnce({
    profileId: "one",
    authorization: null,
    errorCode: "operator_offline"
  });
  await load();
  const older = deferred<typeof ready>();
  api.getManagementAuthorization.mockReturnValueOnce(older.promise).mockResolvedValueOnce(ready);
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementCheckAgain") }));
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(screen.getByText(t("serverManagementAdministrator"))).toBeInTheDocument();
  await act(async () => older.reject(new Error("operator_management_failed")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText(t("serverManagementChecking"))).not.toBeInTheDocument();
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(3);
});

it("ignores a late import after its profile is removed without chaining an authorization read", async () => {
  await load();
  const imported = deferred<typeof status>();
  api.importOperatorCredential.mockReturnValue(imported.promise);
  await userEvent.click(screen.getByText(t("serverManagementAdvanced")));
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementImport") }));
  await act(async () => statusChanged({ ...status, profiles: [] }));
  const checks = api.getManagementAuthorization.mock.calls.length;
  await act(async () => imported.resolve(status));
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(checks);
  expect(screen.queryByText(t("serverManagementVerified"))).not.toBeInTheDocument();
  expect(screen.getByText(t("serverManagementEmpty"))).toBeInTheDocument();
});

it("accepts recovery's own credential status event and keeps its success", async () => {
  api.getOperatorControlStatus.mockResolvedValue({
    ...status,
    profiles: [
      {
        ...status.profiles[0],
        hasOperatorCredential: false,
        operatorCredentialPersistence: "missing"
      }
    ]
  });
  await load();
  const recovered = deferred<typeof ready>();
  api.recoverManagement.mockReturnValue(recovered.promise);
  const code = `pw_recover_${"A".repeat(43)}`;
  await userEvent.type(screen.getByLabelText(t("serverManagementRecoveryCode")), code);
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementRecover") }));
  const next = {
    ...status,
    profiles: [{ ...status.profiles[0], credentialRevision: "recovered" }]
  };
  api.getOperatorControlStatus.mockRejectedValueOnce(new Error("operator_management_failed"));
  api.getManagementAuthorization.mockResolvedValue(ready);
  await act(async () => statusChanged(next));
  await act(async () => recovered.resolve(ready));
  expect(await screen.findByText(t("serverManagementVerified"))).toBeInTheDocument();
});

it("checks the current credential after an action sees a same-target replacement", async () => {
  await load();
  const pending = deferred<typeof ready>();
  api.reauthorizeManagement.mockReturnValue(pending.promise);
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  const replacementStatus = {
    ...status,
    profiles: [{ ...status.profiles[0], credentialRevision: "external-replacement" }]
  };
  api.getOperatorControlStatus.mockResolvedValue(replacementStatus);
  api.getManagementAuthorization.mockResolvedValue({
    profileId: "one",
    authorization: null,
    errorCode: "operator_unauthorized"
  });
  await act(async () => statusChanged(replacementStatus));
  await act(async () => pending.resolve(ready));
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(3);
  expect(screen.queryByText(t("serverManagementVerified"))).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(t("serverManagementRecoveryRequired"));
});

it("lets a replacement credential recheck finish without showing the old action error", async () => {
  await load();
  const oldAction = deferred<typeof ready>();
  const currentCheck = deferred<typeof ready>();
  api.reauthorizeManagement.mockReturnValue(oldAction.promise);
  api.getManagementAuthorization.mockReturnValue(currentCheck.promise);
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], credentialRevision: "r2" }]
    })
  );
  await act(async () => oldAction.reject(new Error("operator_management_failed")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(2);
  await act(async () => currentCheck.resolve(ready));
  expect(screen.getByText(t("serverManagementAdministrator"))).toBeInTheDocument();
});

it("does not write an r2 action recheck into a newer r3 credential identity", async () => {
  await load();
  const oldAction = deferred<typeof ready>();
  const r2Read = deferred<typeof ready>();
  api.reauthorizeManagement.mockReturnValue(oldAction.promise);
  api.getManagementAuthorization
    .mockResolvedValueOnce({ profileId: "one", authorization: null, errorCode: null })
    .mockReturnValueOnce(r2Read.promise)
    .mockResolvedValueOnce({
      profileId: "one",
      authorization: null,
      errorCode: "operator_unauthorized"
    });
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  const r2 = { ...status, profiles: [{ ...status.profiles[0], credentialRevision: "r2" }] };
  api.getOperatorControlStatus.mockResolvedValue(r2);
  await act(async () => statusChanged(r2));
  await act(async () => oldAction.resolve(ready));
  await waitFor(() => expect(api.getManagementAuthorization).toHaveBeenCalledTimes(3));
  await act(async () =>
    statusChanged({ ...status, profiles: [{ ...status.profiles[0], credentialRevision: "r3" }] })
  );
  await act(async () =>
    r2Read.resolve({
      ...ready,
      devices: [
        {
          deviceId: "c28d8f73-0881-4a71-b21d-2a69f223aabc",
          deviceName: "Old Mac",
          operatorId: "admin",
          createdAt: "2030-01-01T00:00:00Z",
          lastUsedAt: "2030-01-01T00:00:00Z",
          revokedAt: null
        }
      ]
    })
  );
  expect(screen.queryByText("Old Mac")).not.toBeInTheDocument();
  expect(screen.queryByText(t("serverManagementVerified"))).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(t("serverManagementRecoveryRequired"));
});

it("does not carry A's recovery draft into B after an external profile switch", async () => {
  api.getOperatorControlStatus.mockResolvedValue({
    ...status,
    profiles: [status.profiles[0], { ...status.profiles[1], serverBaseUrl: "https://one.example/" }]
  });
  await load();
  const code = `pw_recover_${"A".repeat(43)}`;
  await userEvent.type(screen.getByLabelText(t("serverManagementRecoveryCode")), code);
  await act(async () =>
    statusChanged({
      ...status,
      activeProfileId: "two",
      profiles: [
        status.profiles[0],
        { ...status.profiles[1], serverBaseUrl: "https://one.example/" }
      ]
    })
  );
  expect(screen.getByLabelText(t("serverManagementRecoveryCode"))).toHaveValue("");
  expect(screen.getByRole("button", { name: t("serverManagementRecover") })).toBeDisabled();
  expect(api.recoverManagement).not.toHaveBeenCalled();
});

it("does not carry A's revoke target into B's authorized device list", async () => {
  const sameOrigin = {
    ...status,
    profiles: [status.profiles[0], { ...status.profiles[1], serverBaseUrl: "https://one.example/" }]
  };
  api.getOperatorControlStatus.mockResolvedValue(sameOrigin);
  const device = (profileId: string, deviceName: string, deviceId: string) => ({
    ...ready,
    profileId,
    deviceId,
    devices: [
      {
        deviceId,
        deviceName,
        operatorId: "admin",
        createdAt: "2030-01-01T00:00:00Z",
        lastUsedAt: "2030-01-01T00:00:00Z",
        revokedAt: null
      }
    ]
  });
  const aId = "c28d8f73-0881-4a71-b21d-2a69f223aabc";
  const bId = "d28d8f73-0881-4a71-b21d-2a69f223aabc";
  api.getManagementAuthorization.mockImplementation(({ profileId }) =>
    Promise.resolve(profileId === "one" ? device("one", "A Mac", aId) : device("two", "B Mac", bId))
  );
  await load();
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementRevoke") }));
  expect(screen.getByText(t("serverManagementRevokeConfirm"))).toBeInTheDocument();
  await act(async () => statusChanged({ ...sameOrigin, activeProfileId: "two" }));
  expect(screen.getByRole("combobox")).toHaveValue("two");
  expect(api.getManagementAuthorization).toHaveBeenLastCalledWith({ profileId: "two" });
  expect(await screen.findByText(/B Mac/)).toBeInTheDocument();
  expect(screen.queryByText(t("serverManagementRevokeConfirm"))).not.toBeInTheDocument();
  expect(api.revokeManagementDevice).not.toHaveBeenCalled();
});

it("clears the recovery draft when the Server origin prop changes", async () => {
  const view = render(<Authorization />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: t("serverManagementDetails") })).toBeEnabled()
  );
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementDetails") }));
  const code = `pw_recover_${"A".repeat(43)}`;
  await userEvent.type(screen.getByLabelText(t("serverManagementRecoveryCode")), code);
  view.rerender(<Authorization origin="https://two.example" />);
  expect(screen.getByLabelText(t("serverManagementRecoveryCode"))).toHaveValue("");
  expect(screen.getByRole("button", { name: t("serverManagementRecover") })).toBeDisabled();
});

it("ignores a late recovery after the operator changes and does not fetch the old status", async () => {
  await load();
  const recovered = deferred<typeof ready>();
  api.recoverManagement.mockReturnValue(recovered.promise);
  await userEvent.type(
    screen.getByLabelText(t("serverManagementRecoveryCode")),
    `pw_recover_${"A".repeat(43)}`
  );
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementRecover") }));
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], operatorId: "new-admin" }]
    })
  );
  const statusReads = api.getOperatorControlStatus.mock.calls.length;
  await act(async () => recovered.resolve(ready));
  expect(api.getOperatorControlStatus).toHaveBeenCalledTimes(statusReads);
  expect(screen.queryByText(t("serverManagementVerified"))).not.toBeInTheDocument();
  expect(screen.getByTestId("management-server-identity")).toHaveTextContent("new-admin");
});

it("rejects an old action after A to B to A even when A has the same final identity", async () => {
  await load();
  const pending = deferred<typeof ready>();
  api.reauthorizeManagement.mockReturnValue(pending.promise);
  await userEvent.click(screen.getByRole("button", { name: t("serverManagementReauthorize") }));
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0], operatorId: "other-admin" }]
    })
  );
  await act(async () =>
    statusChanged({
      ...status,
      profiles: [{ ...status.profiles[0] }]
    })
  );
  const statusReads = api.getOperatorControlStatus.mock.calls.length;
  await act(async () => pending.resolve(ready));
  expect(api.getOperatorControlStatus).toHaveBeenCalledTimes(statusReads);
  expect(screen.queryByText(t("serverManagementVerified"))).not.toBeInTheDocument();
});

it("cleans up the first StrictMode subscription and all polling after unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const unsubscribe = vi.fn();
  api.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusChanged = listener;
    return unsubscribe;
  });
  const view = render(
    <StrictMode>
      <Authorization />
    </StrictMode>
  );
  await waitFor(() => expect(api.getManagementAuthorization).toHaveBeenCalled());
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  const checks = api.getManagementAuthorization.mock.calls.length;
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(checks);
});

it("does not recheck or erase authorization for repeated identical identity events", async () => {
  api.getManagementAuthorization.mockResolvedValue(ready);
  await load();
  const count = api.getManagementAuthorization.mock.calls.length;
  await act(async () => statusChanged({ ...status }));
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(count);
  expect(screen.getByText(t("serverManagementAdministrator"))).toBeInTheDocument();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const t = createTranslator("zh-CN");
function Authorization({ origin = "https://one.example" }: { origin?: string }) {
  const operatorStatus = useOperatorControlStatusSnapshot();
  return (
    <ServerManagementAuthorization serverOrigin={origin} operatorStatus={operatorStatus} t={t}>
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
  api.getManagementAuthorization.mockResolvedValue(ready);
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

it("keeps the restore entry disabled while the initial management check is in flight", async () => {
  const pending = deferred<{
    profileId: string;
    authorization: null;
    errorCode: string;
  }>();
  api.getManagementAuthorization.mockReturnValue(pending.promise);
  await act(async () => {
    render(<Authorization />);
  });
  const action = screen.getByRole("button", { name: t("serverManagementDetails") });
  await waitFor(() =>
    expect(api.getManagementAuthorization).toHaveBeenCalledWith({ profileId: "one" })
  );
  expect(action).toBeDisabled();
  await act(async () => {
    pending.resolve({
      profileId: "one",
      authorization: null,
      errorCode: "operator_credential_missing"
    });
  });
  await waitFor(() => expect(action).toBeEnabled());
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
  expect(screen.queryByRole("option", { name: /two\.example/ })).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole("combobox"), "alternate");
  await waitFor(() =>
    expect(api.getManagementAuthorization).toHaveBeenLastCalledWith({ profileId: "alternate" })
  );
});
