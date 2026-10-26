import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import reefChannelEntry from "../index.js";
import { generateIdentity, seal, type Verdict } from "../protocol/index.js";
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
  transport,
} from "./flow.test-helpers.js";
import { ReefFriendManager } from "./friends.js";
import { createReefRuntimeAuthority } from "./runtime.js";
import {
  getReefReviewOperationState,
  openStores,
  REEF_DELIVERED_MAX_ENTRIES,
  REEF_DELIVERED_NAMESPACE,
  REEF_DELIVERED_TTL_MS,
} from "./state.js";
import { createRuntime } from "./state.test-support.js";
import { ReefInboxConnection, ReefTransportClient } from "./transport.js";
import { createClient, parseRequestUrl } from "./transport.test-helpers.js";
import { openReefTrustStore } from "./trust-store.js";
import type { InboxEntry } from "./types.js";

describe("Reef worker outbound composition", () => {
  const cfg = config();
  const alice = generateIdentity();
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
    await trusted.set("alice", peerTrust(alice));
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
    await trusted.set("alice", peerTrust(alice));
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
    expect(review).toMatchObject({ id, from: "bob#1", to: "alice#1", direction: "outbound" });
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

  it("gates owner commands, lists reviews and rejects revoked authority", async () => {
    const registerCommand = vi.fn();
    reefChannelEntry.register({ registrationMode: "tool-discovery", registerCommand } as never);
    const command: typeof handleReefCommand = registerCommand.mock.calls[0]![0].handler;
    const { digest } = await requestReview();
    const run = (args: string, senderIsOwner = false) => command({ args, senderIsOwner });
    const flowSend = vi.spyOn(flow, "send");
    const approve = `review approve ${digest}`;
    const autonomy = "friend autonomy alice extended";
    for (const args of [
      autonomy,
      approve,
      "friend code",
      "friend request alice code",
      "friend remove alice",
    ]) {
      expect(await run(args)).toEqual({
        text: "Only an authorized owner can change Reef friends or decide reviews. Ask an owner; friendship changes can also use openclaw reef locally.",
      });
    }
    expect(await trusted.get("alice")).toEqual(peerTrust(alice));
    expect(await command({ args: "review list" })).toEqual({
      text: `${digest} outbound bob#1 -> alice#1 safe`,
    });
    for (const action of ["approve", "deny"]) {
      await expect(
        command({
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
    fetcher.mockResolvedValueOnce(Response.json({ friendships: [] }));
    expect(await run("friend list")).toEqual({ text: "No Reef friends." });
    expect(await run(autonomy, true)).toEqual({
      text: "Reef friend @alice autonomy set to extended.",
    });
    expect((await trusted.get("alice"))?.autonomy).toBe("extended");
    expect(await run(approve, true)).toEqual({
      text: "Reef review approved. Retry the identical message to re-run the guard.",
    });
    expect((await stores.reviews.observeDecision(digest)).value).toEqual({ approved: true });
    expect(await run("config relayUrl https://attacker.example", true)).toEqual({
      text: expect.stringContaining("Usage: /reef friend"),
    });
    expect(flowSend).not.toHaveBeenCalled();
  });

  it.each([false, true])("persists a send without host SQL (approved=%s)", async (approved) => {
    const firstSecond = Math.floor(Date.now() / 1000);
    const { id, digest } = approved ? await requestReview() : { id: prepareReefMessageId() };
    if (digest) {
      classify.classify.mockResolvedValue({ ...allow, decision: "review" });
      await stores.reviews.decide(digest, true);
    }
    classify.classify.mockClear();
    const hostSql = observeHostDataSql();
    try {
      expect(await send(id)).toBe(id);
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
    }
    expect(classify.classify).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    const entries = (await audit.entries()).filter(
      (entry) => isRecord(entry.event.payload) && entry.event.payload.id === id,
    );
    expect(entries.map((entry) => entry.event.type)).toEqual(
      approved
        ? ["proposal", "guard_verdict", "proposal", "review_approval", "guard_verdict", "envelope"]
        : ["proposal", "guard_verdict", "envelope"],
    );
    for (const entry of entries) {
      expect(entry.event.ts).toBeGreaterThanOrEqual(firstSecond);
      expect(entry.event.ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    }
    const delivery = (await trusted.readOutboundDelivery("alice", id))?.delivery;
    expect(delivery).toMatchObject({
      recipient: { keyEpoch: 1, ed25519PublicKey: alice.signing.publicKey },
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
    const { id, digest } = await requestReview();
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    await stores.reviews.decide(digest, true);
    await expect(
      flow.send("carol", "private coordination", { messageId: id }),
    ).rejects.toMatchObject({
      reviewOutcome: "pending",
    });
    const [carolReview] = await stores.reviews.list();
    expect(carolReview).toMatchObject({ id, to: "carol#1", direction: "outbound" });
    expect(carolReview?.approvalDigest).not.toBe(digest);
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

  it("refuses removal and reapproval with identical keys while classification is pending", async () => {
    classify.classify.mockImplementationOnce(async () => {
      await trusted.remove("alice");
      await trusted.set("alice", peerTrust(alice));
      return allow;
    });
    await expect(flow.send("alice", "private coordination")).rejects.toThrow(
      "changed trust before dispatch",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the guard audit on a review-capacity refusal without recording delivery", async () => {
    await requestReview();
    const id = prepareReefMessageId();
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    await expect(flow.send("alice", "private coordination", { messageId: id })).rejects.toThrow(
      "pending review capacity",
    );
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

  async function capacityFixture(
    peers = ["alice"],
    deliveredMaxEntries = REEF_DELIVERED_MAX_ENTRIES,
  ) {
    const identities = peers.map((peer) => ({ peer, identity: generateIdentity() }));
    const entries = identities.map(({ peer, identity }, index): InboxEntry => {
      const seq = index + 1;
      const id = `01JZ${String(seq).padStart(22, "0")}`;
      const envelope = seal({
        id,
        from: `${peer}#1`,
        to: "bob#1",
        body: { text: `message ${seq}` },
        senderSigningSecretKey: identity.signing.secretKey,
        recipientEncryptionPublicKey: keys.encryption.publicKey,
      });
      return { seq, peer, id, kind: "message", envelope, ts: Math.floor(Date.now() / 1_000) };
    });
    const capacity = flowStores(deliveredMaxEntries);
    const trust = openReefTrustStore(capacity.runtime, cfg);
    for (const { peer, identity } of identities) {
      await trust.set(peer, peerTrust(identity));
    }
    const raw = capacity.runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: deliveredMaxEntries,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
    const relay = transport();
    const onIngress = vi.fn(async () => {});
    const persisted: number[] = [];
    const pull = vi.fn<typeof fetch>(async (input) => {
      const after = Number(parseRequestUrl(input).searchParams.get("after"));
      const page = entries.filter((entry) => entry.seq > after);
      return Response.json({ entries: page, cursor: page.at(-1)?.seq ?? after });
    });
    async function connect(runtime = capacity.runtime) {
      const { replay, reviews, delivered } = await openStores(runtime, keys, {
        deliveredMaxEntries,
      });
      const inbound = new ReefMessageFlow({
        ...flow.options,
        trust: openReefTrustStore(runtime, cfg),
        transport: relay as unknown as ReefTransportClient, // SAFETY: ack-recording mock satisfies the client contract
        guard: guard(allow),
        audit: openReefAuditStore(runtime, new Uint8Array(32).fill(30)),
        replay,
        reviews,
        delivered,
        onIngress,
      });
      return new ReefInboxConnection(
        createClient(pull),
        async (batch) => {
          await inbound.processEntries(batch);
        },
        () => {
          throw new Error("REST-only proof: no live socket expected");
        },
        { initialCursor: 0, persistCursor: (cursor) => persisted.push(cursor) },
      );
    }
    return { capacity, raw, relay, onIngress, persisted, entries, connect };
  }

  it.each([false, true])("recovers capacity-parked peers (restart=%s)", async (restart) => {
    const peers = restart ? ["alice"] : ["alice", "carol"];
    const { capacity, raw, relay, onIngress, persisted, entries, connect } = await capacityFixture(
      peers,
      peers.length,
    );
    for (const peer of peers) {
      await capacity.delivered.confirm(peer);
    }
    let inbox = await connect();
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(peers.length);
    expect(relay.acknowledge).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
    for (const peer of peers) {
      raw.delete(peer);
    }
    if (restart) {
      inbox = await connect(createRuntime(capacity.stateDir));
    }
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(2 * peers.length);
    expect(relay.acknowledge).toHaveBeenCalledTimes(peers.length);
    for (const entry of entries) {
      expect(await capacity.delivered.status(entry.id)).toBe("delivered");
    }
    expect(persisted.at(-1)).toBe(peers.length);
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(2 * peers.length);
    expect(relay.acknowledge).toHaveBeenCalledTimes(peers.length);
  });

  it("legacy stateless delivered markers suppress re-ingress and acknowledge on the next poll", async () => {
    const { capacity, raw, relay, onIngress, persisted, entries, connect } =
      await capacityFixture();
    const id = entries[0]!.id;
    raw.registerIfAbsent(id, { id });
    await (await connect()).drain();
    expect(onIngress).not.toHaveBeenCalled();
    expect(relay.acknowledge).toHaveBeenCalledTimes(1);
    expect(await capacity.delivered.status(id)).toBe("delivered");
    expect(persisted.at(-1)).toBe(1);
  });
});
