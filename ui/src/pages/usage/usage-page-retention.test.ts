/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as downloads from "../../lib/download.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { selectUsageExport } from "./export-menu.test-support.ts";
import { createUsageDetailFixture } from "./usage-details.test-support.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWeight,
  loadUsagePage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);
async function collectWithControl() {
  const control = new WeakRef({ unowned: true });
  await collectGarbageForTest();
  expect(control.deref()).toBeUndefined();
}

it.each(["export", "connection"] as const)(
  "releases reports after %s while the page stays mounted",
  async (mode) => {
    let report: WeakRef<object> | undefined;
    const snapshot = cacheSnapshot("fresh");
    const request = async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        const weight = params?.includeContextWeight ? contextWeight("exported-context") : undefined;
        const session = {
          key: "agent:main:report-lifetime",
          hasContextWeight: true,
          usage: snapshot.result.totals,
          ...(weight ? { contextWeight: weight } : {}),
        };
        report = new WeakRef(weight ? weight.skills.entries[0]! : session);
        return { ...snapshot.result, sessions: [session] };
      }
      return { providers: [] };
    };
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
    const { page, context } = await loadUsagePage(request);
    if (mode === "export") {
      await selectUsageExport(page.querySelector(".usage-export-menu")!, "json");
      await waitForFast(() => expect(download).toHaveBeenCalledOnce());
      expect(download.mock.calls[0]![1]).toContain("exported-context");
    } else {
      context.setGatewaySnapshot({
        client: { request: async () => ({}) } as unknown as GatewayBrowserClient,
      });
      await page.updateComplete;
      expect(page.usageResult).toBeNull();
    }
    await collectWithControl();
    expect(report).toBeDefined();
    expect(report!.deref()).toBeUndefined();
    expect(page.isConnected).toBe(true);
  },
);

it("keeps cancelled details displayed and releases them on explicit clear", async () => {
  const payloads: WeakRef<object>[] = [];
  const request = async (method: string) => {
    const payload = { timestamp: 1, totalTokens: 10, role: "user", content: "Selected session" };
    payloads.push(new WeakRef(payload));
    return method === "sessions.usage.logs" ? { logs: [payload] } : { points: [payload] };
  };
  const { details } = createUsageDetailFixture({ request } as unknown as GatewayBrowserClient);
  await details.timeSeries.load("agent:main:detail-lifetime");
  await details.sessionLogs.load("agent:main:detail-lifetime");
  details.cancel();
  await collectWithControl();
  expect(payloads).toHaveLength(2);
  expect(payloads.every((payload) => payload.deref() !== undefined)).toBe(true);
  for (const detail of [details.timeSeries, details.sessionLogs]) {
    expect(detail.data).not.toBeNull();
  }

  details.clear();
  await collectGarbageForTest();
  expect(payloads.every((payload) => payload.deref() === undefined)).toBe(true);
  expect(details).toMatchObject({ timeSeries: { data: null }, sessionLogs: { data: null } });
});
