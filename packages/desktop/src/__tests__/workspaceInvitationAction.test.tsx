/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceInvitationAction } from "../renderer/team/WorkspaceInvitationAction";
import { createTranslator } from "../renderer/i18n";

const t = createTranslator("en");
afterEach(cleanup);
describe("Workspace invitation copy", () => {
  it("keeps one request pending and confirms only after the clipboard operation completes", async () => {
    let complete!: (ok: boolean) => void;
    const onCopy = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        })
    );
    render(<WorkspaceInvitationAction busy={false} onCopy={onCopy} t={t} />);
    await userEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(screen.getByTestId("workspace-copy-invitation")).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(onCopy).toHaveBeenCalledTimes(1);
    await act(async () => complete(true));
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a failed copy retryable without exposing the internal error", async () => {
    const onCopy = vi
      .fn()
      .mockRejectedValueOnce(new Error("operator_offline: private detail"))
      .mockResolvedValueOnce(true);
    render(<WorkspaceInvitationAction busy={false} onCopy={onCopy} t={t} />);
    await userEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not copy the invitation");
    expect(screen.queryByText(/operator_offline/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not issue a project invitation when workspace invitation authority is unavailable", async () => {
    const onCopy = vi.fn();
    render(<WorkspaceInvitationAction busy={false} unavailable onCopy={onCopy} t={t} />);
    await userEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(onCopy).not.toHaveBeenCalled();
    expect(screen.getByText(/invitation permission/)).toBeVisible();
  });
});
