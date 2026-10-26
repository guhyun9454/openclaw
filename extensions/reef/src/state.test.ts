import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRequest } from "../protocol/index.js";
import { reefKeys } from "./flow.test-helpers.js";
import { REEF_REPLAY_TTL_MS, reefReplayStoreKey } from "./replay-store.js";
import {
  assertReefIdentityBinding,
  clearReefSetupSession,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  loadReefSetupSession,
  openStores,
  finalizeReefIdentityBinding,
  REEF_DELIVERED_NAMESPACE,
  ReefDeliveredStore,
  REEF_REVIEWS_NAMESPACE,
  releaseReefIdentityReservation,
  reserveReefIdentityBinding,
  ReviewApprovalStore,
  saveReefSetupSession,
} from "./state.js";
import {
  beforeNextStateOperation,
  cleanupStateTestDirectory,
  expectReefStateOperationError,
  createRuntime,
  createStateTestDirectory,
} from "./state.test-support.js";

const receiptId = "01JZ0000000000000000000000";
const identityBinding = (handle: string) => ({ handle, relayUrl: "https://reefwire.ai" });
let stateDir = "";
let runtime: ReturnType<typeof createRuntime>;
const reopen = () => createRuntime(stateDir);
const reserve = (handle: string) => reserveReefIdentityBinding(runtime, identityBinding(handle));

beforeEach(() => {
  stateDir = createStateTestDirectory();
  runtime = reopen();
});
afterEach(() => cleanupStateTestDirectory(stateDir));

const rawStore = (namespace: string, maxEntries = 1) =>
  runtime.state.openKeyedStoreV2({ namespace, maxEntries, overflowPolicy: "reject-new" });

function assertNoHostSql(calls: ReturnType<typeof observeHostDataSql>["calls"], restore = false) {
  for (const call of calls) {
    expect(call).not.toHaveBeenCalled();
    if (restore) {
      call.mockRestore();
    }
  }
}

function reviewRequest(id = receiptId, approvalDigest = "b".repeat(64)): ReviewRequest {
  return {
    id,
    from: "alice#1",
    to: "bob#1",
    direction: "outbound",
    bodyHash: "a".repeat(64),
    approvalDigest,
    verdict: {
      decision: "review",
      category: "ambiguous",
      reason: "Owner review.",
      model: "test-model",
      policyVersion: "v1",
    },
  };
}

const decision = async (store: ReviewApprovalStore, digest: string) =>
  (await store.observeDecision(digest)).value;
const expectCapacityError = (pending: Promise<unknown>) =>
  expectReefStateOperationError(
    pending,
    "Reef pending review capacity is exhausted",
    "ReefReviewCapacityError",
  );

async function bindIdentity(handle: string): Promise<void> {
  await finalizeReefIdentityBinding(runtime, await reserve(handle));
}

describe("Reef SQLite state", () => {
  it.each([
    ["durable-migration", "legacy-files", "durable state", "state"],
    ["identity-migration", "keys-json", "identity", "identity"],
    ["registration", "identity", "", ""],
  ] as const)(
    "rechecks a concurrent %s guard before creating keys",
    async (namespace, key, kind, files) => {
      const registration = namespace === "registration";
      const guard = rawStore(namespace, registration ? 2 : 1);
      const value = registration ? identityBinding("original") : { pending: true };
      beforeNextStateOperation(runtime, () => guard.register(key, value));
      await expectReefStateOperationError(
        generateAndStoreKeys(runtime),
        registration
          ? "Reef identity @original on https://reefwire.ai has no stored keys; restore the original keys before registration"
          : `Reef ${kind} migration is incomplete; repair the legacy ${files} files and rerun openclaw doctor --fix`,
      );
      expect(await rawStore("identity").lookup("keys")).toBeUndefined();
    },
  );

  it("does not create a database for missing identity reads or store admission", async () => {
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

    await expect(loadKeys(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.existsSync(databasePath)).toBe(false);
    await openStores(runtime, reefKeys());
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("persists keys and registration state without creating Reef files", async () => {
    const sql = observeHostDataSql().calls;
    const keys = await generateAndStoreKeys(runtime);
    expect(await loadKeys(reopen())).toEqual(keys);
    await bindIdentity("molty");
    await saveReefSetupSession(runtime, {
      session: "setup-secret",
      relayUrl: "https://reefwire.ai",
      email: "molty@example.com",
    });

    expect(await loadReefIdentityBinding(reopen())).toEqual(identityBinding("molty"));
    expect((await loadReefSetupSession(reopen()))?.session).toBe("setup-secret");
    await clearReefSetupSession(runtime);
    expect(await loadReefSetupSession(runtime)).toBeUndefined();
    assertNoHostSql(sql);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "data", "reef"))).toBe(false);
  });

  it("atomically rejects redirecting stored identity keys to another handle", async () => {
    await bindIdentity("molty");

    await expect(reserve("other")).rejects.toThrow("already holds the Reef identity @molty");
    expect(await loadReefIdentityBinding(runtime)).toEqual(identityBinding("molty"));
    await expect(assertReefIdentityBinding(runtime, identityBinding("other"))).rejects.toThrow(
      "already holds the Reef identity @molty",
    );
  });

  it("conditionally releases or finalizes an identity reservation", async () => {
    const released = await reserve("first");
    await releaseReefIdentityReservation(runtime, released);
    expect(await loadReefIdentityBinding(runtime)).toBeUndefined();

    const finalized = await reserve("second");
    await finalizeReefIdentityBinding(runtime, finalized);
    await releaseReefIdentityReservation(runtime, finalized);
    expect(await loadReefIdentityBinding(runtime)).toEqual(identityBinding("second"));
  });

  it("does not transfer a live reservation to a concurrent retry", async () => {
    const reservation = await reserve("molty");

    await expect(reserve("molty")).rejects.toThrow("already holds the Reef identity @molty");
    await finalizeReefIdentityBinding(runtime, reservation);
    expect((await loadReefIdentityBinding(runtime))?.handle).toBe("molty");
  });

  it("allows only the same binding to take over an expired reservation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const original = await reserve("molty");
    vi.advanceTimersByTime(10 * 60_000 + 1);

    await expect(reserve("other")).rejects.toThrow("already holds the Reef identity @molty");
    const retry = await reserve("molty");
    await releaseReefIdentityReservation(runtime, original);
    await expect(finalizeReefIdentityBinding(runtime, original)).rejects.toThrow(
      "reservation was replaced",
    );
    await finalizeReefIdentityBinding(runtime, retry);
    expect((await loadReefIdentityBinding(runtime))?.handle).toBe("molty");
  });

  it("reserves only one identity when registrations overlap", async () => {
    const outcomes = await Promise.allSettled(
      ["first", "second"].map((handle) =>
        reserveReefIdentityBinding(reopen(), identityBinding(handle)),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (winner?.status !== "fulfilled") {
      throw new Error("expected one registration to reserve the identity");
    }
    await finalizeReefIdentityBinding(reopen(), winner.value);
    expect(await loadReefIdentityBinding(reopen())).toEqual(winner.value.binding);
  });

  it("does not steal a live replay claim owned by another process", async () => {
    const raw = runtime.state.openKeyedStoreV2({
      namespace: "replay",
      maxEntries: 3_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
    });
    const key = reefReplayStoreKey("alice", receiptId);
    await raw.register(key, {
      peer: "alice",
      id: receiptId,
      envelopeHash: "c".repeat(64),
      state: "in_flight",
      claimOwner: "other-process",
      claimExpiresAt: Date.now() + 5 * 60_000,
    });
    const replay = (await openStores(runtime, reefKeys())).replay;
    await expect(replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("in_flight");
    await expect(raw.lookup(key)).resolves.toMatchObject({ claimOwner: "other-process" });
  });

  it("persists review decisions", async () => {
    const keys = reefKeys();
    const { reviews } = await openStores(reopen(), keys);
    const review = reviewRequest();
    const digest = review.approvalDigest;

    await expect(reviews.request(review)).resolves.toBeUndefined();
    await expect(decision(reviews, digest)).resolves.toBe("pending");
    await expect(decision(reviews, "c".repeat(64))).resolves.toBe("none");
    await expect(reviews.decide(digest, true)).resolves.toMatchObject({
      id: review.id,
      direction: "outbound",
    });
    await expect(reviews.decide("c".repeat(64), true)).resolves.toBeUndefined();
    const pendingReview = { ...review, id: "pending", approvalDigest: "d".repeat(64) };
    await reviews.request(pendingReview);
    const { reviews: restored } = await openStores(reopen(), keys);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const sql = observeHostDataSql().calls;
    await expect(decision(restored, digest)).resolves.toEqual({ approved: true });
    await expect(decision(restored, pendingReview.approvalDigest)).resolves.toBe("pending");
    await expect(decision(restored, "c".repeat(64))).resolves.toBe("none");
    await expect(restored.list()).resolves.toEqual([pendingReview]);
    assertNoHostSql(sql, true);
    await expect(restored.request(review)).resolves.toEqual({
      approved: true,
      approvalDigest: digest,
    });
  });

  it.each(["keys", "lookup", "list", "cursor load", "cursor advance"] as const)(
    "rejects borrowed worker %s after authority revocation",
    async (method) => {
      const controller = new AbortController();
      const reviews = new ReviewApprovalStore(runtime, undefined, controller.signal);
      const cursor = new ReefInboxCursorStore(runtime, identityBinding("molty"));
      const guarded = new ReefInboxCursorStore(
        runtime,
        identityBinding("molty"),
        controller.signal,
      );
      if (method === "keys") {
        await generateAndStoreKeys(runtime);
      } else if (method.startsWith("cursor")) {
        await cursor.advance(12);
      } else {
        await reviews.request(reviewRequest());
      }
      const refusal = new Error("borrowed worker state expired");
      beforeNextStateOperation(
        runtime,
        () => controller.abort(refusal),
        method === "cursor advance" ? "before" : "after",
      );
      const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
      await expect(
        method === "keys"
          ? loadKeys(runtime, () => controller.signal.throwIfAborted())
          : method === "lookup"
            ? reviews.observeDecision(reviewRequest().approvalDigest)
            : method === "list"
              ? reviews.list()
              : method === "cursor load"
                ? guarded.load()
                : guarded.advance(13),
      ).rejects.toBe(refusal);
      if (method.startsWith("cursor")) {
        await expect(cursor.load()).resolves.toBe(12);
        expect(native).not.toHaveBeenCalled();
      }
    },
  );

  it("never treats a malformed stored approval as owner authorization", async () => {
    const reviews = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    const raw = rawStore(REEF_REVIEWS_NAMESPACE, 2_000);
    const malformed = { review, approved: "false" };
    await raw.register(review.approvalDigest, malformed);
    for (const operation of [
      () => reviews.observeDecision(review.approvalDigest),
      () => reviews.request(review),
      () => reviews.decide(review.approvalDigest, true),
    ]) {
      await expectReefStateOperationError(operation(), "invalid Reef review record");
    }
    await expect(raw.lookup(review.approvalDigest)).resolves.toEqual(malformed);
  });

  it("preserves a review replaced by pending work before transaction admission", async () => {
    const reviews = new ReviewApprovalStore(runtime, 1);
    const first = reviewRequest("first", "1".repeat(64));
    const next = reviewRequest("next", "2".repeat(64));
    await reviews.request(first);
    await reviews.decide(first.approvalDigest, true);
    const raw = rawStore(REEF_REVIEWS_NAMESPACE);
    beforeNextStateOperation(runtime, () => raw.register(first.approvalDigest, { review: first }));

    await expectCapacityError(reviews.request(next));
    await expect(reviews.list()).resolves.toEqual([first]);
    await expect(decision(reviews, next.approvalDigest)).resolves.toBe("none");
  });

  it.each(["request", "channel decision", "owner decision"] as const)(
    "refuses %s after authority expires before worker admission",
    async (action) => {
      const controller = new AbortController();
      const reviews = new ReviewApprovalStore(runtime, 1, controller.signal);
      const first = reviewRequest("first", "1".repeat(64));
      await reviews.request(first);
      if (action === "request") {
        await reviews.decide(first.approvalDigest, false);
      }
      const revoked = new Error("review authority expired");
      const owner = new AbortController();
      beforeNextStateOperation(runtime, () =>
        (action === "owner decision" ? owner : controller).abort(revoked),
      );
      await expect(
        action === "request"
          ? reviews.request(reviewRequest("next", "2".repeat(64)))
          : reviews.decide(first.approvalDigest, true, () => owner.signal.throwIfAborted()),
      ).rejects.toBe(revoked);
      const reopened = new ReviewApprovalStore(reopen(), 1);
      await expect(decision(reopened, first.approvalDigest)).resolves.toEqual(
        action === "request" ? { approved: false } : "pending",
      );
      await expect(decision(reopened, "2".repeat(64))).resolves.toBe("none");
    },
  );

  it("invalidates approval receipts immediately and orders review mutations across handles", async () => {
    const reviews = new ReviewApprovalStore(runtime);
    const sibling = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    await reviews.request(review);
    await reviews.decide(review.approvalDigest, true);
    const receipt = await reviews.observeDecision(review.approvalDigest);
    expect(receipt.value).toEqual({ approved: true });
    receipt.assertCurrent();

    const revocation = reviews.decide(review.approvalDigest, false);
    const pending: Promise<unknown>[] = [revocation];
    try {
      expect(() => receipt.assertCurrent()).toThrow("no longer current");
      const reapproval = reviews.decide(review.approvalDigest, true);
      const finalRevocation = sibling.decide(review.approvalDigest, false);
      const observed = reviews.observeDecision(review.approvalDigest);
      pending.push(reapproval, finalRevocation, observed);
      const settled = await Promise.all([
        revocation,
        reapproval,
        finalRevocation,
        observed.then((observedReceipt) => observedReceipt.value),
      ]);
      expect(settled).toEqual([review, review, review, { approved: false }]);
    } finally {
      await Promise.allSettled(pending);
    }
  });

  it("preserves review source while an earlier acknowledgement waits", async () => {
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runtime = createRuntime(env);
    const reviews = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    const original = structuredClone(review);
    const retained = reviewRequest("retained", "d".repeat(64));
    await reviews.request(retained);

    const redirectedDir = path.join(stateDir, "redirected");
    const redirected = new ReviewApprovalStore(createRuntime(redirectedDir));
    await redirected.request({ ...original, id: "redirected" });
    await redirected.decide(original.approvalDigest, false);
    await redirected.request(reviewRequest("elsewhere", "e".repeat(64)));

    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    beforeNextStateOperation(
      runtime,
      async () => {
        entered.resolve();
        await finish.promise;
      },
      "after",
    );
    const request = reviews.request(review);
    await entered.promise;
    const approved = reviews.decide(original.approvalDigest, true);
    const lookup = reviews.observeDecision(original.approvalDigest);
    const pending = reviews.list();
    env.OPENCLAW_STATE_DIR = redirectedDir;
    finish.resolve();

    try {
      await expect(request).resolves.toBeUndefined();
      await expect(approved).resolves.toEqual(original);
      await expect(lookup.then((receipt) => receipt.value)).resolves.toEqual({ approved: true });
      await expect(pending).resolves.toEqual([retained]);
      await expect(decision(redirected, original.approvalDigest)).resolves.toEqual({
        approved: false,
      });
    } finally {
      finish.resolve();
      await Promise.allSettled([request, approved, lookup, pending]);
    }
  });

  it("fails when a delivered marker claim does not persist", async () => {
    const openKeyedStore = runtime.state.openKeyedStoreV2;
    runtime.state.openKeyedStoreV2 = <T>(
      options: OpenAsyncKeyedStoreOptions,
    ): PluginStateKeyedStore<T, 2> => {
      const store = openKeyedStore<T>(options);
      return options.namespace === REEF_DELIVERED_NAMESPACE
        ? { ...store, registerIfAbsent: async () => false }
        : store;
    };

    await expect(
      (await openStores(runtime, reefKeys())).delivered.confirm(receiptId),
    ).rejects.toThrow("Failed persisting Reef delivered marker");
  });

  it("deduplicates concurrent pending reviews and evicts only completed decisions at capacity", async () => {
    const sql = observeHostDataSql();
    const store = new ReviewApprovalStore(runtime, 1);

    const first = reviewRequest("first", "1".repeat(64));
    const second = reviewRequest("second", "2".repeat(64));
    const third = reviewRequest("third", "3".repeat(64));

    await expect(Promise.all([store.request(first), store.request(first)])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await store.decide(first.approvalDigest, false);
    await store.request(second);
    await expectCapacityError(store.request(third));

    await expect(store.list()).resolves.toEqual([second]);
    assertNoHostSql(sql.calls);
  });
});

describe("Reef delivered markers", () => {
  it("confirms delivered markers idempotently", async () => {
    const sql = observeHostDataSql().calls;
    const delivered = new ReefDeliveredStore(reopen());
    await expect(delivered.status("m1")).resolves.toBeUndefined();
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await expect(new ReefDeliveredStore(reopen()).status("m1")).resolves.toBe("delivered");
    assertNoHostSql(sql);
  });

  it("surfaces capacity as PLUGIN_STATE_LIMIT_EXCEEDED from confirm without touching existing markers", async () => {
    const stores = await openStores(reopen(), reefKeys(), { deliveredMaxEntries: 1 });
    await stores.delivered.confirm("first");
    await expect(stores.delivered.confirm("second")).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    await expect(stores.delivered.status("second")).resolves.toBeUndefined();
    await expect(stores.delivered.status("first")).resolves.toBe("delivered");
  });
});
