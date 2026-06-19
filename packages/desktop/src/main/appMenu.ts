import { Menu, app, type MenuItemConstructorOptions } from "electron";

type ApplicationMenuOptions = {
  checkForUpdates: () => Promise<unknown>;
};

export function registerApplicationMenu({ checkForUpdates }: ApplicationMenuOptions): void {
  app.setName("PlanWeave");
  const template: MenuItemConstructorOptions[] = [
    {
      label: "PlanWeave",
      submenu: [
        { label: "About PlanWeave", role: "about" },
        {
          label: "Check for Updates",
          click: () => {
            void checkForUpdates();
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
