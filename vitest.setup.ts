import { afterEach } from "vitest";

/**
 * Clear PlanWeave path overrides after every test so a later file in the same
 * Vitest worker cannot inherit another suite's home or Desktop settings file.
 * Individual tests still set their own temporary paths when they need them.
 */
afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});
