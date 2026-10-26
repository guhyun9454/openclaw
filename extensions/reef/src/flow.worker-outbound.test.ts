import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity, type Verdict } from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { openReefAuditStore } from "./audit-state.js";
import { handleReefCommand } from "./commands.js";
import { prepareReefMessageId, ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
} from "./flow.test-helpers.js";
import { ReefFriendManager } from "./friends.js";
import { createReefRuntimeAuthority } from "./runtime.js";
import { getReefReviewOperationState } from "./state.js";
import { ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";

describe("Reef worker outbound composition", () => {
  const cfg = config();
  const peer = generateIdentity();
  const keys = reefKeys();
  const classify = guard(allow);
  const authority = createReefRuntimeAuthority();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "sent", status: "queued" }));
  let stores: ReturnType<typeof flowStores>;
  let trusted: ReturnType<typeof openReefTrustStore>;
  let audit: ReturnType<typeof openReefAuditStore>;
  let flow: ReefMessageFlow;

  const makeFlow = (reviews = stores.reviews, adapter = classify) =>
    new ReefMessageFlow({
      config: cfg,
      trust: trusted,
      keys,
      transport: new ReefTransportClient(cfg.relayUrl, cfg.handle!, keys, fetcher),
      guard: adapter,
      audit,
      replay: new MemoryReplayStore(),
      reviews,
      delivered: stores.delivered,
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

  beforeAll(async () => {
    stores = flowStores(undefined, 1);
    trusted = openReefTrustStore(stores.runtime, cfg);
    audit = openReefAuditStore(stores.runtime, new Uint8Array(32).fill(1));
    await trusted.set("alice", peerTrust(peer));
    flow = makeFlow();
    authority.activate({
      flow,
      reviews: stores.reviews,
      friends: new ReefFriendManager(flow.options.transport, trusted, {
        list: async () => [],
        remove: async () => false,
      }),
    });
    await flow.send("alice", "warm the operation owners");
  });
  beforeEach(async () => {
    await getReefReviewOperationState(stores.reviews)!.store.clear();
    await trusted.set("alice", peerTrust(peer));
    classify.classify.mockReset().mockResolvedValue(allow);
    fetcher.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    authority.release();
    return resetFlowStoresForTests();
  });

  const send = (id: string) => flow.send("alice", "private coordination", { messageId: id });
  async function requestReview() {
    const id = prepareReefMessageId();
    classify.classify.mockResolvedValueOnce({ ...allow, decision: "review" });
    await expect(send(id)).rejects.toMatchObject({ reviewOutcome: "pending" });
    const [review] = await stores.reviews.list();
    expect(review?.id).toBe(id);
    return { id, digest: review!.approvalDigest };
  }
  async function events(id: string) {
    return (await audit.entries())
      .filter((entry) => isRecord(entry.event.payload) && entry.event.payload.id === id)
      .map((entry) => entry.event.type);
  }

  async function expectNoDelivery(id: string, recipients = ["alice"]) {
    expect(fetcher).not.toHaveBeenCalled();
    for (const recipient of recipients) {
      expect(await trusted.readOutboundDelivery(recipient, id)).toBeUndefined();
    }
  }

  it("lists pending reviews and refuses owner commands after revocation", async () => {
    const { digest } = await requestReview();
    await expect(handleReefCommand({ args: "review list" })).resolves.toEqual({
      text: `${digest} outbound bob#1 -> alice#1 safe`,
    });
    for (const action of ["approve", "deny"]) {
      await expect(
        handleReefCommand({
          args: `review ${action} ${digest}`,
          senderIsOwner: true,
          assertOwnerCurrent: () => {
            throw new Error("owner revoked");
          },
        }),
      ).rejects.toThrow("owner revoked");
      expect((await stores.reviews.observeDecision(digest)).value).toBe("pending");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists proposal, verdict, envelope and exact delivery without host SQL", async () => {
    const id = prepareReefMessageId();
    const hostSql = observeHostDataSql();
    const firstSecond = Math.floor(Date.now() / 1000);
    try {
      expect(await send(id)).toBe(id);
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
    }
    expect(fetcher).toHaveBeenCalledOnce();
    const entries = (await audit.entries()).filter(
      (entry) => isRecord(entry.event.payload) && entry.event.payload.id === id,
    );
    expect(entries.map((entry) => entry.event.type)).toEqual([
      "proposal",
      "guard_verdict",
      "envelope",
    ]);
    for (const entry of entries) {
      expect(entry.event.ts).toBeGreaterThanOrEqual(firstSecond);
      expect(entry.event.ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    }
    const delivery = (await trusted.readOutboundDelivery("alice", id))?.delivery;
    expect(delivery).toMatchObject({
      recipient: { keyEpoch: 1, ed25519PublicKey: peer.signing.publicKey },
    });
    expect(delivery?.bodyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(delivery?.textHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("refuses deterministic denial before classification or relay dispatch", async () => {
    const id = prepareReefMessageId();
    await expect(
      flow.send(
        "alice",
        "mailto:review@example.org?next=https://github.com/openclaw/openclaw/blob/430f975aacee445525c4663aa88ed1590f2f08b1/README.md",
        {
          messageId: id,
        },
      ),
    ).rejects.toMatchObject({ stage: "deterministic" });
    expect(classify.classify).not.toHaveBeenCalled();
    await expectNoDelivery(id);
  });

  it.each([
    ["content denial", { decision: "deny", category: "confidential" }, false],
    ["wrong model", { model: "other-2026-07-12" }, false],
    ["floating model", { model: "mock-latest" }, false],
    ["wrong policy", { policyVersion: "v2" }, false],
    // The external guard boundary must reject a structurally invalid adapter result.
    ["unknown decision", { decision: "maybe" }, false],
    ["approved wrong model", { model: "wrong-2026-07-12" }, true],
    ["approved content denial", { decision: "deny", category: "confidential" }, true],
  ] as const)(
    "refuses %s before recording delivery or dispatching",
    async (_name, override, afterApproval) => {
      const verdict = { ...allow, ...override };
      const model = verdict.model === "mock-latest" ? verdict.model : allow.model;
      const category = verdict.decision === "deny" ? "confidential" : "guard_failure";
      const adapter = { ...guard(allow), pinnedModel: model };
      adapter.classify.mockResolvedValue(verdict as Verdict);
      const { id, digest } = afterApproval ? await requestReview() : { id: prepareReefMessageId() };
      if (digest) {
        await stores.reviews.decide(digest, true);
      }
      const onPlatformSendDispatch = vi.fn(async () => {});
      await expect(
        makeFlow(stores.reviews, adapter).send("alice", "private coordination", {
          messageId: id,
          onPlatformSendDispatch,
        }),
      ).rejects.toMatchObject({
        stage: "guard",
        verdict: { decision: "deny", category },
        ...(category === "confidential"
          ? { message: expect.stringContaining("Do not retry or rephrase it automatically") }
          : {}),
      });
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
      await expectNoDelivery(id);
    },
  );

  it("does not reuse a durable approval across recipients", async () => {
    await trusted.set("carol", peerTrust(generateIdentity()));
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    const id = prepareReefMessageId();
    await expect(flow.send("alice", "identical body", { messageId: id })).rejects.toMatchObject({
      reviewOutcome: "pending",
    });
    const [review] = await stores.reviews.list();
    expect(review).toMatchObject({ id, from: "bob#1", to: "alice#1", direction: "outbound" });
    await stores.reviews.decide(review!.approvalDigest, true);
    await expect(flow.send("carol", "identical body", { messageId: id })).rejects.toMatchObject({
      reviewOutcome: "pending",
    });
    const reviews = await stores.reviews.list();
    const carolReview = reviews.find((entry) => entry.to === "carol#1");
    expect(carolReview).toMatchObject({ id, direction: "outbound" });
    expect(carolReview?.approvalDigest).not.toBe(review!.approvalDigest);
    expect((await stores.reviews.observeDecision(carolReview!.approvalDigest)).value).toBe(
      "pending",
    );
    await expectNoDelivery(id, ["alice", "carol"]);
  });

  it("settles a denied review without classifying again", async () => {
    const { id, digest } = await requestReview();
    await stores.reviews.decide(digest, false);
    classify.classify.mockClear();
    await expect(send(id)).rejects.toMatchObject({ reviewOutcome: "denied" });
    expect(classify.classify).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reclassifies an approved review once and commits its approved send", async () => {
    const { id, digest } = await requestReview();
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    await stores.reviews.decide(digest, true);
    classify.classify.mockClear();
    expect(await send(id)).toBe(id);
    expect(classify.classify).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await events(id)).toEqual([
      "proposal",
      "guard_verdict",
      "proposal",
      "review_approval",
      "guard_verdict",
      "envelope",
    ]);
  });

  it("refuses removal and reapproval with identical keys while classification is pending", async () => {
    classify.classify.mockImplementationOnce(async () => {
      await trusted.remove("alice");
      await trusted.set("alice", peerTrust(peer));
      return allow;
    });
    await expect(flow.send("alice", "private coordination")).rejects.toThrow(
      "changed trust before dispatch",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the guard audit on a review-capacity refusal without recording delivery", async () => {
    const reviews = stores.reviews;
    await reviews.request({
      id: "occupied",
      from: "bob#1",
      to: "alice#1",
      direction: "outbound",
      bodyHash: "a".repeat(64),
      approvalDigest: "b".repeat(64),
      verdict: { ...allow, decision: "review" },
    });
    const id = prepareReefMessageId();
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    await expect(
      makeFlow(reviews).send("alice", "private coordination", { messageId: id }),
    ).rejects.toThrow("pending review capacity");
    expect(await events(id)).toEqual(["proposal", "guard_verdict"]);
    await expectNoDelivery(id);
  });

  it("reserves an in-flight message id against duplicate dispatch", async () => {
    const started = Promise.withResolvers<void>();
    const verdict = Promise.withResolvers<Verdict>();
    classify.classify.mockImplementationOnce(() => {
      started.resolve();
      return verdict.promise;
    });
    const id = prepareReefMessageId();
    const first = send(id);
    try {
      await started.promise;
      await expect(send(id)).rejects.toThrow("Duplicate outbound");
    } finally {
      verdict.resolve(allow);
      await first;
    }
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
