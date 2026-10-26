/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { listSubagents } from "../chat-subagent-wait.ts";
import { ChatSubagentActivity } from "./chat-subagent-activity-live.tsx";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

type ActivityElement = SolidBridgeElement<SubagentActivityProps>;

it("keeps live child headlines scoped to their run, incarnation, and connection", async () => {
  const connection = createApplicationGateway();
  connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([]) });
  const parent = {
    key: "agent:main:parent",
    kind: "direct",
  } satisfies GatewaySessionRow;
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:child",
    sessionId: "child-id",
    lifecycleRevision: "incarnation-1",
    kind: "direct",
    label: "Backend implementation",
    spawnedBy: parent.key,
    hasActiveRun: true,
    activeRunIds: ["child-run"],
  };
  const rows = (session: GatewaySessionRow) =>
    listSubagents({
      selectedSession: parent,
      subagentSessions: [session],
      subagentSessionsHydrated: true,
    });
  const sessions = createTestSessionCapability(connection.gateway);
  const subscribe = vi.spyOn(sessions, "subscribeMessages");
  const unsubscribe = vi.spyOn(sessions, "unsubscribeMessages");
  const provider = createSolidApplicationContextProvider(
    createContext(connection.gateway, sessions),
  );
  const view = mountSolid(() => createComponent(ChatSubagentActivity, { rows: rows(child) }), {
    wrapper: provider.wrapper,
  });
  const element = view.container.querySelector<ActivityElement>("openclaw-chat-subagent-activity")!;
  onTestFinished(() => {
    view.unmount();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  flush();
  const publish = (event: string, payload: unknown, settle = true) => {
    connection.publishEvent({ type: "event", event, payload });
    if (settle) {
      flush();
    }
  };
  const narrate = (text: string, runId = "child-run") =>
    publish("session.narration", { sessionKey: child.key, runId, text });
  const digest: SessionObserverDigest = {
    sessionKey: child.key,
    agentId: "main",
    sessionId: child.sessionId,
    lifecycleRevision: child.lifecycleRevision,
    runId: "child-run",
    revision: 2,
    updatedAt: 2_000,
    headline: "Verifying the API response",
    health: "on-track",
  };
  const emit = (patch: Partial<SessionObserverDigest> = {}, settle = true) =>
    publish("session.observer", { ...digest, ...patch }, settle);
  narrate("Reading sources. **Checking the API response.**");
  expect(element.textContent).not.toContain("Checking the API response.");
  await emit();
  expect(element.textContent).toContain(digest.headline);
  for (const patch of [
    { revision: 1 },
    { runId: "old-run" },
    { sessionId: "replaced-child" },
    { lifecycleRevision: "old-incarnation" },
    { agentId: "other" },
    { sessionKey: "agent:main:unrelated" },
  ]) {
    await emit({ ...patch, headline: "Stale activity" });
    expect(element.textContent).not.toContain("Stale activity");
  }
  await emit({
    revision: 4,
    headline: "Running the backend tests",
    planProgress: { completed: 1, total: 3 },
  });
  expect(element.textContent).toContain("Running the backend tests");
  expect(element.querySelector(".chat-subagent-activity__steps")?.textContent).toBe("1/3");
  expect(element.querySelector("meter")?.value).toBe(1);
  expect(element.querySelector(".chat-subagent-activity__row")?.getAttribute("title")).toBe(
    "Backend implementation. Running. Running the backend tests. 1 of 3 steps",
  );
  await emit({ revision: 5, headline: "Running the backend tests" });
  expect(element.querySelector(".chat-subagent-activity__steps")).toBeNull();
  connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([]) });
  flush();
  expect(element.textContent).not.toContain("Running the backend tests");
  await emit();
  expect(element.textContent).toContain(digest.headline);
  element.rows = rows({ ...child, activeRunIds: ["replacement-run"] });
  await emit({ revision: 10 });
  expect(element.textContent).not.toContain(digest.headline);
  element.rows = rows(child);
  flush();
  expect(element.textContent).not.toContain(digest.headline);
  await emit({ revision: 11 });
  expect(element.textContent).toContain(digest.headline);
  // Queue both revisions before flushing to preserve the ordering regression.
  emit(
    {
      revision: 13,
      headline: "Finishing verification",
      planProgress: { completed: 2, total: 3 },
    },
    false,
  );
  emit({ revision: 12, headline: "Superseded verification" }, false);
  flush();
  expect(element.textContent).toContain("Finishing verification");
  expect(element.textContent).not.toContain("Superseded verification");
  expect(element.querySelector(".chat-subagent-activity__steps")?.textContent).toBe("2/3");
  connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([]) });
  await emit();
  expect(element.textContent).toContain(digest.headline);
  expect(element.querySelector(".chat-subagent-activity__steps")).toBeNull();
  view.unmount();
  flush();
  expect(subscribe).not.toHaveBeenCalled();
  expect(unsubscribe).not.toHaveBeenCalled();
  await emit({ runId: "replacement-run" });
  expect(view.container.textContent).toBe("");
});
