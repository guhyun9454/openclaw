import { describe, expect, it, vi } from "vitest";
import * as withdrawal from "../../config/sessions/session-pending-input-withdrawal.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { updateRpcSourceSessionId } from "../../sessions/session-controller.rpc-sources.js";
import { registerChatAbortController } from "../chat-abort.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  createActiveRun as createUnscopedRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({
    cfg: {},
    agentId: "main",
    canonicalKey: "main",
    entry: { sessionId: "main-session" },
    storePath: "/synthetic/withdrawal/sessions.json",
  }),
}));

function queuedRun(runId: string) {
  const source = createUnscopedRun("main", {
    storeScope: "/synthetic/withdrawal/sessions.json",
    sessionId: "main-session",
    agentId: "main",
    queued: true,
    runId,
  });
  const context = createChatAbortContext({
    sources: [[runId, source]],
  });
  return { source, context };
}

function withdraw(context: Parameters<typeof invokeChatAbortHandler>[0]["context"], runId: string) {
  return invokeChatAbortHandler({
    handler: handleChatAbortRequestWithLifecycle,
    context,
    request: { sessionKey: "main", runId, discardPendingInput: true },
    client: { connect: { scopes: ["operator.admin"] } },
  });
}

describe("chat.abort exact controller input withdrawal", () => {
  it("retains captured identity when duplicate admission is refused during withdrawal", async () => {
    const runId = "withdrawal-collision";
    const { source, context } = queuedRun(runId);
    let foreign: ReturnType<typeof registerChatAbortController> | undefined;
    using discard = vi
      .spyOn(withdrawal, "discardSessionPendingInput")
      .mockImplementation(async (_scope, _runId, assertCurrent) => {
        assertCurrent();
        foreign = registerChatAbortController({
          target: captureSessionTarget({
            storeScope: "/synthetic/foreign-withdrawal/sessions.json",
            sessionKey: "main",
            incarnation: "main-session",
            agentId: "main",
          }),
          sessionKey: "main",
          sessionId: "main-session",
          agentId: "main",
          timeoutMs: 60_000,
          runId,
        });
        expect(foreign.registered).toBe(false);
        updateRpcSourceSessionId(source, "rebound-session");
        assertCurrent();
        return true;
      });
    await expect(withdraw(context, runId)).rejects.toThrow("Run changed before input removal");
    expect(discard).toHaveBeenCalledOnce();
    expect(source.input).toMatchObject({ abortSignal: { aborted: false }, withdrawalHolds: 0 });
    expect(foreign).toMatchObject({ controller: { signal: { aborted: false } } });
  });

  it("never withdraws a byte-distinct protocol run", async () => {
    const { source, context } = queuedRun(" source ");
    using discard = vi.spyOn(withdrawal, "discardSessionPendingInput");
    const respond = await withdraw(context, "source");
    expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
    expect(discard).not.toHaveBeenCalled();
    expect(source.input.abortSignal.aborted).toBe(false);
  });
});
