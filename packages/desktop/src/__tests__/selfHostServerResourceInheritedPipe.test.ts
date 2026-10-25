import { once } from "node:events";
import { access, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { createAdvisoryControlServer } from "../../../runtime/src/__tests__/support/advisoryControlServer.js";
import {
  launchResource,
  ownedStore,
  resourceFixture
} from "./support/selfHostServerResourceHarness.js";

it.skipIf(process.platform === "win32")(
  "bounds independent deploy drain and exits while a live writer holds stdout and stderr",
  async () => {
    const control = await createAdvisoryControlServer();
    const f = await resourceFixture("deploy-failure", true);
    f.env.TEST_CONTROL_PORT = String(control.port);
    f.env.STORE_TEST_INHERIT_PIPE = "1";
    const run = launchResource(f);
    const exited = once(run.child, "exit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const writer = await run.writerReady;
      await control.wait("writer", "parent-terminal");
      const result = await Promise.race([
        exited.then(([code]) => ({ code })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 32500);
        })
      ]);
      expect(
        result,
        "build script must fail and exit before writer closes inherited pipes"
      ).toEqual({ code: 1 });
      expect(() => process.kill(writer.pid, 0)).not.toThrow();
      await access(writer.store);
      control.send("writer", "release");
      await control.wait("writer", "writer-terminal");
      const done = await run.done;
      expect(done.stderr).toContain("store retained");
      expect(done.stderr).toContain("exit 7");
      await access(await ownedStore(f));
      f.env.STORE_TEST_WRITER = "0";
      f.env.STORE_TEST_MODE = "success";
      expect((await launchResource(f).done).code).toBe(0);
      await access(writer.store);
    } finally {
      clearTimeout(timer);
      if (!control.messages.some((message) => message.event === "writer-terminal"))
        control.send("writer", "release");
      await run.done;
      await control.close();
      await rm(f.root, { recursive: true, force: true });
    }
  },
  40000
);
