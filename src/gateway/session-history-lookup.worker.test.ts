import fs from "node:fs";
import zlib from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as projection from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { withHistoryState } from "./session-history-events.test-support.js";
import {
  readSessionMessageByIdAsync as readById,
  readSessionMessageCountAsync as readCount,
  readSessionMessagesMatchingIdAsync as readMatches,
} from "./session-transcript-readers.js";

afterEach(() => vi.restoreAllMocks());

it("keeps empty and reset-archive lookup results without creating a missing database", () =>
  withHistoryState(async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "missing-lookup",
      sessionKey: "agent:main:missing-lookup",
      storePath: state.statePath("missing.sqlite"),
    };
    const archived = (id: string, options: Parameters<typeof readById>[2] = {}) =>
      readById(scope, id, { ...options, allowResetArchiveFallback: true });
    const absent = { found: false, oversized: false };
    expect(await readById(scope, "archived")).toEqual(absent);
    fs.writeFileSync(
      state.statePath(`${scope.sessionId}.jsonl.reset.2026-09-23T00-00-00.000Z`),
      [
        { type: "session", version: 3, id: scope.sessionId },
        ...[
          { id: "archived", message: { role: "user", content: "Retained reset message" } },
          {
            id: "archived-pair",
            timestamp: 1000,
            message: { role: "assistant", content: "x".repeat(256 * 1024) },
          },
        ].map((event, index, events) =>
          Object.assign({ type: "message", parentId: events[index - 1]?.id ?? null }, event),
        ),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    expect(await archived("archived")).toMatchObject({
      found: true,
      message: { content: "Retained reset message" },
    });
    expect(await archived("archived", { currentOnly: true, maxBytes: 1024 })).toEqual(absent);
    expect(
      await archived("archived-pair", { historyVisibility: { sessionStartedAt: 2000 } }),
    ).toEqual({ ...absent, historyHidden: true });
    expect(
      await archived("archived-pair", { historyVisibility: { sessionStartedAt: 500 } }),
    ).toEqual({ found: true, oversized: true, seq: 2 });
    expect(await readCount(scope)).toBe(0);
    expect(fs.existsSync(scope.storePath)).toBe(false);

    fs.writeFileSync(scope.storePath, "unreadable database");
    await expect(readCount(scope)).rejects.toThrow();
    await expect(readById(scope, "archived")).rejects.toThrow();
    expect(fs.readFileSync(scope.storePath, "utf8")).toBe("unreadable database");
  }));

it("reads process-held incognito history by its key or explicit sentinel path", () =>
  withHistoryState(async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "incognito-lookup",
      sessionKey: "agent:main:dashboard:incognito-lookup",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1, incognito: true });
    await appendTranscriptMessage(scope, {
      eventId: "private",
      parentId: null,
      message: { role: "user", content: "Private history" },
    });
    for (const sessionKey of [scope.sessionKey, undefined]) {
      const target = { ...scope, sessionKey };
      expect(await readMatches(target, "private")).toMatchObject([{ content: "Private history" }]);
      expect(await readCount(target)).toBe(1);
      expect(await readById(target, "private")).toMatchObject({
        found: true,
        oversized: false,
        seq: 1,
        message: { content: "Private history" },
      });
    }
  }));

it("restores cold lookup bytes and validates selected payloads off the caller thread", () =>
  withHistoryState(async (state) => {
    const fixture = await createSessionColdStorageFixture(
      resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    );
    const read = () => readMatches(fixture.scope, "history-assistant");
    const expected = await read();
    expect(expected).toMatchObject([{ content: [{ text: "Preserved response" }] }]);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toMatchObject({ archivedTranscripts: 1 });
    const decode = vi.spyOn(zlib, "zstdDecompressSync");
    const snapshot = vi.spyOn(projection, "withCurrentProjectionSnapshot");
    expect(await read()).toEqual(expected);
    expect(await read()).toEqual(expected);
    expect(decode).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();

    // Exact reads still validate their selected payload after an external rewrite.
    fixture
      .database()
      .prepare(
        `UPDATE transcript_events
         SET event_json = ?, event_zstd = NULL, event_utf8_bytes = NULL, navigation_json = NULL
         WHERE session_id = ? AND seq = (
           SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?
         )`,
      )
      .run("{malformed", fixture.scope.sessionId, fixture.scope.sessionId, "history-assistant");
    await expect(read()).rejects.toThrow();
  }));
