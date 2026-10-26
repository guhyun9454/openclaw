import { describe, expect, it, vi } from "vitest";
import {
  PROGRESS_CARD_MAX_STEPS,
  PROGRESS_CARD_MAX_UTF8_BYTES,
  type ProgressCard,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ProgressCardStore } from "../../session-cards/progress-card-store.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withRestoredMocks } from "../../test-utils/vitest-spies.js";
import { progressCardStore } from "../progress-card-store.js";
import { progressCardHandlers } from "./progress-card.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const defaultSessionKey = "agent:main:main";
function expectCard(respond: ReturnType<typeof vi.fn>, card: unknown) {
  expect(respond).toHaveBeenCalledWith(true, { card }, undefined);
}
function expectError(respond: ReturnType<typeof vi.fn>, message: string, code = "INVALID_REQUEST") {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining(message), code }),
  );
}
function createHarness() {
  let card: ProgressCard | null = null;
  const get = vi.fn<ProgressCardStore["get"]>(async () => card);
  const put = vi.fn<ProgressCardStore["put"]>(async (sessionKey, input) => {
    if (!input.markdown && !input.steps?.length) {
      if (input.expectedRevision === undefined || card?.revision === input.expectedRevision) {
        card = null;
      }
      return { card };
    }
    card = {
      sessionKey,
      revision: (card?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      ...(input.markdown ? { markdown: input.markdown } : {}),
      ...(input.steps ? { steps: input.steps } : {}),
    };
    return { card };
  });
  const broadcast = vi.fn();
  const invoke = async (
    operation: "get" | "put",
    params: Record<string, unknown> = {},
    respond = vi.fn<RespondFn>(),
  ) => {
    const getSpy = vi.spyOn(progressCardStore, "get").mockImplementation(get);
    const putSpy = vi.spyOn(progressCardStore, "put").mockImplementation(put);
    return withRestoredMocks([getSpy, putSpy], async () => {
      await progressCardHandlers[`progressCard.${operation}`]!({
        params: { sessionKey: defaultSessionKey, ...params },
        respond,
        context: {
          broadcast,
          getRuntimeConfig: () => ({ agents: { entries: { main: {}, work: {} } } }),
        } as unknown as GatewayRequestContext,
      } as never);
      return respond;
    });
  };
  return { broadcast, invoke, get, put };
}

describe("progress card gateway methods", () => {
  it.each(["get", "put"] as const)(
    "reports rejected %s without publishing or retrying",
    async (operation) => {
      const harness = createHarness();
      const release = createDeferredCore<never>();
      harness[operation].mockImplementationOnce(() => release.promise);
      const respond = vi.fn<RespondFn>();
      const pending = harness.invoke(operation, {}, respond);
      release.reject(new Error("storage unavailable"));
      await pending;
      expectError(respond, "storage unavailable", "UNAVAILABLE");
      expect(respond).toHaveBeenCalledOnce();
      expect(harness.broadcast).not.toHaveBeenCalled();
      expect(harness[operation]).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { agentId: "missing", message: "Unknown agent id" },
    { agentId: "bad owner", message: "Unknown agent id" },
    { agentId: "work", message: 'does not match session key agent "main"' },
  ])("rejects explicit owner $agentId before accessing cards", async ({ agentId, message }) => {
    const { broadcast, invoke, get, put } = createHarness();
    for (const method of ["get", "put"] as const) {
      expectError(await invoke(method, { agentId }), message, "INVALID_REQUEST");
    }
    expect([get.mock.calls, put.mock.calls, broadcast.mock.calls]).toEqual([[], [], []]);
  });

  it("roundtrips markdown and steps, strips invisible Unicode, and broadcasts the revision", async () => {
    const { broadcast, invoke } = createHarness();
    const put = await invoke("put", {
      markdown: "A\u200bB\u202eC",
      plan: [{ step: "Inspect\u200b\u202e", status: "in_progress" }],
    });
    const expected = expect.objectContaining({
      markdown: "ABC",
      steps: [{ step: "Inspect", status: "in_progress" }],
      revision: 1,
    });
    expectCard(put, expected);
    expectCard(await invoke("get"), expected);
    expect(broadcast).toHaveBeenCalledWith(
      "progressCard.changed",
      { sessionKey: defaultSessionKey, revision: 1 },
      { sessionKeys: [defaultSessionKey], agentId: "main" },
    );
  });

  it.each([
    {
      name: "oversized markdown",
      payload: { markdown: "é".repeat(PROGRESS_CARD_MAX_UTF8_BYTES / 2 + 1) },
      message: `${PROGRESS_CARD_MAX_UTF8_BYTES} UTF-8 bytes`,
    },
    {
      name: "too many steps",
      payload: {
        plan: Array.from({ length: PROGRESS_CARD_MAX_STEPS + 1 }, (_, index) => ({
          step: `Step ${index}`,
          status: "pending",
        })),
      },
      message: `more than ${PROGRESS_CARD_MAX_STEPS} items`,
    },
  ])("rejects $name without broadcasting", async ({ payload, message }) => {
    const { broadcast, invoke } = createHarness();
    expectError(await invoke("put", payload), message);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
