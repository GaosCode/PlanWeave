import { Menu, app, dialog, type MenuItemConstructorOptions } from "electron";
import type { AppUpdateState } from "../shared/appUpdate.js";
import { createNativeTranslator } from "../shared/nativeI18n.js";

type ApplicationMenuOptions = {
  checkForUpdates: () => Promise<AppUpdateState>;
};

function showUpToDateDialog(state: AppUpdateState): void {
  const version = state.currentVersion;
  const t = createNativeTranslator(app.getLocale());
  void dialog.showMessageBox({
    buttons: [t.ok],
    cancelId: 0,
    defaultId: 0,
    detail: t.appUpdateUpToDateDetail(version),
    message: t.appUpdateUpToDateMessage,
    title: "PlanWeave",
    type: "info"
  });
}

export function registerApplicationMenu({ checkForUpdates }: ApplicationMenuOptions): void {
  app.setName("PlanWeave");
  const t = createNativeTranslator(app.getLocale());
  const template: MenuItemConstructorOptions[] = [
    {
      label: "PlanWeave",
      submenu: [
        { label: t.aboutPlanWeave, role: "about" },
        {
          label: t.checkForUpdates,
          click: () => {
            void checkForUpdates()
              .then((state) => {
                if (state.status === "not-available") {
                  showUpToDateDialog(state);
                }
              })
              .catch((error: unknown) => {
                console.error(error instanceof Error ? error.message : String(error));
              });
          }
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
