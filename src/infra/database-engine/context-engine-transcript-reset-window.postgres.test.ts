import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import {
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptVisibleMessageDeltaParams,
} from "../../plugin-sdk/context-engine-transcript-runtime.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

// Retained-tail pages select positions through a JSON array binding, which must expand on
// PostgreSQL as well as SQLite. The public reader runs the full worker and projection path.
describe.skipIf(!mixedAgentConnection)("PostgreSQL context-engine reset-window reads", () => {
  const fixture = useMixedAgentPair("postgres", "postgres");
  beforeAll(() => setRuntimeConfigSnapshot({}));
  const scope = (sessionId: string) => ({
    agentId: "main",
    env: { ...process.env },
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(fixture.root, "shared", "shared.sqlite"),
  });

  // Drains every page the way a context engine would, returning entry ids.
  async function drain(params: SessionTranscriptVisibleMessageDeltaParams) {
    const ids: string[] = [];
    let cursor = params.cursor;
    for (;;) {
      const next = await readSessionTranscriptVisibleMessageDelta({ ...params, cursor });
      if (next.kind !== "page") {
        throw new Error(`expected a transcript page, got ${next.kind}`);
      }
      ids.push(...next.entries.map((entry) => entry.entryId));
      cursor = next.cursor;
      if (!next.hasMore) {
        return ids;
      }
    }
  }

  it("drains the retained tail, then the post-reset suffix, after a preserve-tail reset", async () => {
    const target = scope("preserve-tail");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const toolResult = (toolCallId: string, text: string) => ({
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
    });
    const messages = [
      ...Array.from({ length: 5 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `${i % 2 ? "a" : "q"}${i}`,
      })),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
      toolResult("call-1", "paired"),
      toolResult("orphan-call", "orphan"),
      { role: "assistant", content: "a8" },
      { role: "user", content: "q9" },
      { role: "assistant", content: "a10" },
    ];
    for (const [index, message] of messages.entries()) {
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        eventId: `old-${index}`,
        message,
      });
    }
    // A reset that keeps the tail from old-4, as a preserve-tail session reset records it.
    const manager = await SessionManager.openAsync(target, fixture.root);
    await manager.appendResetBoundaryAsync("idle", "old-4");
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId: "new-user",
      message: { role: "user", content: "new" },
    });

    // The default start is unchanged and still includes pre-reset history.
    await expect(drain({ ...target, maxMessages: 4 })).resolves.toEqual([
      ...Array.from({ length: 11 }, (_, i) => `old-${i}`),
      "new-user",
    ]);
    // Same scenario as the SQLite SDK test: the retained tail (without the orphan result),
    // then the suffix. Small pages force retained positions through the array binding.
    await expect(drain({ ...target, maxMessages: 4, start: "reset-window" })).resolves.toEqual([
      "old-4",
      "old-5",
      "old-6",
      "old-8",
      "old-9",
      "old-10",
      "new-user",
    ]);
  });
});
