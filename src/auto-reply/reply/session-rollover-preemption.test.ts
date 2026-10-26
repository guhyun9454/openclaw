import { once } from "node:events";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { disposeAllSessionMcpRuntimes } from "../../agents/agent-bundle-mcp-manager-api.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  bindSessionControllerTarget,
  captureSessionTarget,
  isSessionMutationActive,
} from "../../sessions/session-controller.lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => null,
}));

const tempDirs = createTempDirTracker();
afterAll(tempDirs.cleanup);

afterEach(async () => {
  vi.useRealTimers();
  await disposeAllSessionMcpRuntimes();
  await closeOpenClawStateDatabaseAsync();
});

async function rolloverFixture(suffix: string) {
  const storePath = path.join(tempDirs.make("openclaw-rollover-preemption-"), "sessions.json");
  const sessionKey = `agent:main:telegram:dm:rollover-${suffix}`;
  const sessionId = `session-before-${suffix}-rollover`;
  await writeSessionStoreFast(storePath, {
    [sessionKey]: { sessionId, updatedAt: Date.now() },
  });
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: [sessionId],
    incarnation: sessionId,
    agentId: "main",
  });
  return { storePath, sessionKey, sessionId, target };
}

function resetSession(storePath: string, sessionKey: string) {
  return initSessionState({
    ctx: {
      Body: "/new",
      From: "rollover-user",
      To: "bot",
      ChatType: "direct",
      SessionKey: sessionKey,
      Provider: "telegram",
      Surface: "telegram",
    },
    cfg: { session: { store: storePath } },
  });
}

it("preempts a running turn and cancels two queued follow-ups before /new resets", async () => {
  const { storePath, sessionKey, sessionId, target } = await rolloverFixture("admission");
  const runStarted = createDeferred();
  let runInterrupted = false;
  const activeRun = withSessionTurn(
    { sessionKey, sessionId, target },
    async (_operation, signal) => {
      runStarted.resolve();
      await once(signal, "abort");
      runInterrupted = true;
    },
  );
  await runStarted.promise;
  for (const prompt of ["first waiting follow-up", "second waiting follow-up"]) {
    expect(
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun(
          { prompt },
          { sessionKey, sessionId, agentId: "main", config: { session: { store: storePath } } },
        ),
        { mode: "followup", debounceMs: 60_000 },
        "none",
        undefined,
        false,
      ),
    ).toBe(true);
  }
  expect(getFollowupQueueDepth(sessionKey)).toBe(2);
  const initialization = resetSession(storePath, sessionKey);

  try {
    const result = await initialization;
    await activeRun;
    expect(runInterrupted).toBe(true);
    expect(result).toMatchObject({ sessionId, resetTriggered: true });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
  } finally {
    clearSessionQueues([sessionKey, sessionId]);
    await Promise.allSettled([initialization, activeRun]);
  }
});

it("preserves the rollover timeout error when /new preemption does not settle", async () => {
  const { storePath, sessionKey, sessionId, target } = await rolloverFixture("timeout");
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    target,
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  const preemptAttempted = createDeferred();
  vi.spyOn(operation, "abort").mockImplementation(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preemptAttempted.resolve();
    return false;
  });
  const initialization = resetSession(storePath, sessionKey);
  void initialization.catch(() => {});
  try {
    await preemptAttempted.promise;
    expect(isSessionMutationActive(storePath, target.aliases)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    await expect(initialization).rejects.toThrow(
      `timed out draining work before reply session rollover: ${sessionKey}`,
    );
  } finally {
    operation.complete();
    await initialization.catch(() => undefined);
  }
});
