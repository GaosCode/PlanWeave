/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { serializeCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { setupApi } from "./collaborationConnectFormTestSupport";

afterEach(cleanupRendererTestEnvironment);

describe("CollaborationConnectForm Server setup onboarding", () => {
  it("redeems one complete setup handoff without exposing manual fields", async () => {
    const user = userEvent.setup();
    const api = setupApi();
    const handoff = serializeCollaborationSetupHandoffV1({
      serverBaseUrl: "http://192.168.1.20:56584/",
      setupCode: `pw_setup_${"A".repeat(43)}`,
      allowInsecureTransport: true
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-setup-code")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("people-connect-setup-details"), {
      target: { value: handoff }
    });
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() =>
      expect(api.redeemCollaborationSetupCode).toHaveBeenCalledWith({
        serverBaseUrl: "http://192.168.1.20:56584/",
        setupCode: `pw_setup_${"A".repeat(43)}`,
        allowInsecureTransport: true,
        displayName: "Collaboration"
      })
    );
    expect(screen.getByTestId("people-connect-setup-details")).toHaveValue("");
  });

  it("keeps the previous fields behind an explicit manual disclosure", async () => {
    const user = userEvent.setup();

    render(
      <CollaborationConnectForm
        api={setupApi()}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.click(screen.getByTestId("people-connect-setup-manual-toggle"));

    expect(screen.getByTestId("people-connect-display-name")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-server-url")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-setup-code")).toBeInTheDocument();
  });

  it("rejects malformed complete setup details before invoking the bridge", async () => {
    const user = userEvent.setup();
    const api = setupApi();

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.type(screen.getByTestId("people-connect-setup-details"), "not setup details");
    await user.click(screen.getByTestId("people-connect-submit"));

    expect(await screen.findByTestId("people-connect-error")).toHaveTextContent(
      "These Server connection details are incomplete or invalid"
    );
    expect(api.redeemCollaborationSetupCode).not.toHaveBeenCalled();
  });
});
