import { afterEach } from "vitest";

/**
 * Clear PLANWEAVE_HOME after every test so a later file in the same Vitest
 * worker cannot inherit another suite's home directory. Individual tests still
 * set their own mkdtemp homes when they need one.
 */
afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});
