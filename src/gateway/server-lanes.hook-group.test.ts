import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as gate } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";

function publish(config: OpenClawConfig): void {
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
}

const HOOKS_ON = {
  hooks: { enabled: true, token: "t" },
} as unknown as OpenClawConfig;
const HOOKS_OFF = {} as OpenClawConfig;
const cronSnapshot = () => getCommandLaneSnapshot(CommandLane.CronNested);
const hookSnapshot = () => getCommandLaneSnapshot(CommandLane.HookDispatch);

function fillCron() {
  const gates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => gate());
  const runs = gates.map((g) =>
    enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
      warnAfterMs: 10_000,
    }),
  );
  return async () => {
    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("cron+hook capacity group", () => {
  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    const { resetSessionSuspensionStateForTest } =
      await import("../agents/session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    resetCommandQueueStateForTest();
  });

  it("hooks-off immediately drains cron work released by the teardown", async () => {
    // Teardown must wake released work without another enqueue.
    publish(HOOKS_ON);
    const finishCron = fillCron();
    await settle();
    expect(cronSnapshot()).toMatchObject({
      activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
      queuedCount: 1,
      blockedBy: "sibling-reservation",
    });
    publish(HOOKS_OFF);
    await settle();
    expect(cronSnapshot().group).toBeUndefined();
    expect(cronSnapshot()).toMatchObject({
      activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
      queuedCount: 0,
    });
    await finishCron();
    expect(cronSnapshot().blockedBy).toBeNull();
  });

  it("keeps in-flight hooks inside the aggregate budget while disabling hooks", async () => {
    publish(HOOKS_ON);

    const hookGate = gate();
    const hookRun = enqueueCommandInLane(
      CommandLane.HookDispatch,
      async () => await hookGate.promise,
      { warnAfterMs: 10_000 },
    );
    const finishCron = fillCron();
    await settle();

    expect(cronSnapshot().activeCount).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
    expect(hookSnapshot().groupActive).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);

    publish(HOOKS_OFF);
    await settle();

    // Running hooks retain the aggregate cap after their lane closes.
    expect(hookSnapshot()).toMatchObject({
      maxConcurrent: 0,
      group: "cron-hooks",
      reservedForLane: 0,
      activeCount: 1,
    });
    expect(cronSnapshot()).toMatchObject({
      activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
      queuedCount: 1,
      groupActive: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    });

    let lateHookStarted = false;
    const lateHook = enqueueCommandInLane(CommandLane.HookDispatch, async () => {
      lateHookStarted = true;
    });
    await settle();
    expect(lateHookStarted).toBe(false);
    expect(hookSnapshot().queuedCount).toBe(1);

    hookGate.resolve();
    await hookRun;
    await settle();

    // The released slot belongs to cron, not the closed hook lane.
    expect(cronSnapshot()).toMatchObject({
      activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
      queuedCount: 0,
      groupActive: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    });
    expect(lateHookStarted).toBe(false);

    await finishCron();

    publish(HOOKS_ON);
    await lateHook;
    expect(lateHookStarted).toBe(true);
  });
});
