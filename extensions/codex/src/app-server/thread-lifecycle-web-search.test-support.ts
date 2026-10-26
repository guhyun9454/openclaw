import { expect, it } from "vitest";
import { threadStartResult } from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import type {
  createLeasedCodexLifecycleHarness,
  startOrResumeAttemptThreadWithoutSkills,
  CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";

type WebSearchBindingFixtures = {
  createPaths: () => { sessionFile: string; workspaceDir: string };
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
  createSequentialLifecycleHarness: (
    resume: (params?: unknown) => ReturnType<typeof threadStartResult>,
  ) => ReturnType<typeof createLeasedCodexLifecycleHarness>;
  startOrResumeThread: (
    input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>,
  ) => ReturnType<typeof startOrResumeAttemptThreadWithoutSkills>;
  createDeferredNamedDynamicTool: (name: string) => LifecycleInput["dynamicTools"][number];
  preflightMethods: readonly string[];
};

/** Search-policy cases retain the binding suite's shared lifecycle setup and cleanup. */
export function registerThreadWebSearchBindingTests({
  createPaths,
  createParams,
  createSequentialLifecycleHarness,
  startOrResumeThread,
  createDeferredNamedDynamicTool,
  preflightMethods,
}: WebSearchBindingFixtures) {
  it.each([false, true])(
    "retains the correct search binding (persistent denial: %s)",
    async (persistent) => {
      const { sessionFile, workspaceDir } = createPaths();
      const params = createParams(sessionFile, workspaceDir);
      if (!persistent) {
        params.model = createCodexTestModel("codex");
      }
      const fixture = await createSequentialLifecycleHarness((input) =>
        threadStartResult(persistent ? (input as { threadId: string }).threadId : "thread-1"),
      );
      const { client, request } = fixture;
      const start = (restricted = false, initial = false) =>
        startOrResumeThread({
          client,
          params,
          dynamicTools: initial && persistent ? [createDeferredNamedDynamicTool("web_search")] : [],
          nativeCodeModeEnabled: initial && persistent ? undefined : !restricted,
          persistentWebSearchAllowed: !(persistent && restricted),
          webSearchAllowed: !restricted,
        });

      await start(false, true);
      params.toolsAllow = ["message"];
      if (persistent) {
        params.config = { tools: { deny: ["web_search"] } };
        params.pluginHarnessToolPolicyScope = "conversation";
      }
      await fixture.endTurn("thread-1");
      const restrictedBinding = await start(true);
      const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
      if (!persistent) {
        params.toolsAllow = undefined;
      }
      await fixture.endTurn("thread-2");
      const resumedBinding = await start(persistent);

      expect(restrictedBinding.threadId).toBe("thread-2");
      expect(savedAfterRestriction?.threadId).toBe(persistent ? "thread-2" : "thread-1");
      expect(resumedBinding.threadId).toBe(persistent ? "thread-2" : "thread-1");
      expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(
        persistent ? "thread-2" : "thread-1",
      );
      if (!persistent) {
        expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
      }
      const lifecycle = request.mock.calls.filter(
        ([method]) => method === "thread/start" || method === "thread/resume",
      );
      expect(lifecycle.map(([method]) => method)).toEqual([
        "thread/start",
        "thread/start",
        "thread/resume",
      ]);
      if (!persistent) {
        expect(lifecycle[0]?.[1]).toMatchObject({ config: { web_search: "cached" } });
        expect(lifecycle[1]?.[1]).toMatchObject({ config: { web_search: "disabled" } });
      } else {
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          ...preflightMethods,
          ...`thread/start thread/unsubscribe config/read thread/start thread/unsubscribe
      config/read thread/read thread/resume thread/inject_items`.split(/\s+/),
        ]);
      }
    },
  );
}
