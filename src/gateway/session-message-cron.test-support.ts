import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import { resolveCronDeliveryPlan } from "../cron/delivery-plan.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { dispatchCronDelivery } from "../cron/isolated-agent/delivery-dispatch.js";
import { makeBaseParams } from "../cron/isolated-agent/delivery-dispatch.test-fixtures.js";
import {
  type createGatewaySuiteHarness,
  type onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

const requireRecord = createRequireRecord("object", "expected-label-object");

type SessionEventHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

export function registerCronSessionCompletionEventTests({
  getHarness,
  createSessionStoreFile,
  connectSessionClient,
  waitForSessionMessageEvent,
}: {
  getHarness: () => SessionEventHarness;
  createSessionStoreFile: () => Promise<string>;
  connectSessionClient: (
    ws: WebSocket,
    storePath: string,
    identityName: string,
    kind: "web",
  ) => Promise<void>;
  waitForSessionMessageEvent: (ws: WebSocket, sessionKey: string) => ReturnType<typeof onceMessage>;
}) {
  test.each(["current", "isolated"] as const)(
    "publishes a %s completion live and restores it once from WebChat history after retry",
    async (sessionTarget) => {
      using sockets = new DisposableStack();
      const harness = getHarness();
      const storePath = await createSessionStoreFile();
      const sessionId = "sess-current-cron-completion";
      const sessionKey = "agent:main:webchat:direct:cron-owner";
      const generation = { sessionId, lifecycleRevision: "current-cron-revision" };
      const text = "The detached cron finished without another user message.";
      await writeSessionStore({
        entries: {
          "webchat:direct:cron-owner": {
            ...generation,
            updatedAt: Date.now(),
          },
        },
        storePath,
      });

      const connect = async () => {
        const ws = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
        sockets.defer(() => ws.close());
        await connectSessionClient(ws, storePath, "current-cron-web-device", "web");
        return ws;
      };
      const webWs = await connect();
      await rpcReq(webWs, "sessions.messages.subscribe", { key: sessionKey });

      const job = makeCronJob({
        id: "job-webchat",
        sessionTarget,
        sessionKey,
        sourceConversation:
          sessionTarget === "isolated" ? { sessionKey, ...generation } : undefined,
        delivery: { mode: "announce", channel: "last" },
      });
      const liveEventPromise = waitForSessionMessageEvent(webWs, sessionKey);
      const deliveryParams = {
        ...makeBaseParams({ synthesizedText: text, runStartedAt: 3_000 }),
        cfgWithAgentDefaults: { session: { store: storePath } },
        job,
        sourceSessionKey: sessionKey,
        sourceSessionGeneration: generation,
        resolvedDelivery: {
          ok: false as const,
          channel: "webchat",
          mode: "implicit" as const,
          error: new Error("WebChat uses canonical session events"),
        },
        deliveryPlan: resolveCronDeliveryPlan(job),
      };
      const dispatched = await dispatchCronDelivery(deliveryParams);
      expect(dispatched).toMatchObject({ delivered: true, deliveryAttempted: true });

      const liveEvent = await liveEventPromise;
      const livePayload = requireRecord(liveEvent.payload, "background completion event");
      const completionMessage = {
        __openclaw: {
          idempotencyKey: "cron-current-completion:cron:job-webchat:3000",
        },
        content: [{ type: "text", text }],
        openclawAutomation: {
          kind: "cron",
          jobId: "job-webchat",
          runId: "cron:job-webchat:3000",
        },
        role: "assistant",
      };
      expect(livePayload.message).toMatchObject(completionMessage);
      await expect(dispatchCronDelivery(deliveryParams)).resolves.toMatchObject({
        delivered: true,
      });

      webWs.close();
      const reconnectedWebWs = await connect();
      const history = await rpcReq<{ messages?: unknown[] }>(reconnectedWebWs, "chat.history", {
        sessionKey,
      });
      expect(history.ok).toBe(true);
      expect(history.payload?.messages).toMatchObject([
        {
          ...completionMessage,
          __openclaw: {
            id: livePayload.messageId,
            idempotencyKey: "cron-current-completion:cron:job-webchat:3000",
            seq: 1,
          },
        },
      ]);
    },
  );
}
