import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    clearSessionStoreCacheForTest();
    cleanup();
  }),
);
const sessionKey = "agent:main:main";
const baseEntry: SessionEntry = { sessionId: "session-1", updatedAt: 100 };
const storedEntry = (changes: Partial<SessionEntry>): SessionEntry => ({
  ...baseEntry,
  updatedAt: 400,
  delivery: { kind: "none" },
  ...changes,
});

function fixture(initialEntry: SessionEntry = baseEntry) {
  const scope = {
    sessionKey,
    storePath: path.join(tempDirs.make("openclaw-reply-session-store-"), "sessions.json"),
  };
  return {
    ...scope,
    read: () => sessions.loadSessionEntry({ ...scope, readConsistency: "latest" }),
    persist: (
      changes: Partial<SessionEntry> = {},
      options: Omit<
        Parameters<typeof persistReplySessionEntry>[0],
        keyof typeof scope | "entry" | "initialEntry"
      > = {},
    ) =>
      persistReplySessionEntry({
        ...scope,
        initialEntry,
        entry: { ...initialEntry, updatedAt: 250, ...changes },
        ...options,
      }),
    replace: (entry: SessionEntry) => sessions.replaceSessionEntry(scope, entry),
  };
}

describe("persistReplySessionEntry", () => {
  it("rejects account selection authority revoked while waiting for the session writer", async () => {
    const initialEntry: SessionEntry = { ...baseEntry, delivery: { kind: "none" } };
    const { storePath, read, persist, replace } = fixture(initialEntry);
    await replace(initialEntry);
    const entered = createDeferred();
    const release = createDeferred();
    const writer = sessions.patchSessionEntryCore({ sessionKey, storePath }, async () => {
      entered.resolve();
      await release.promise;
      return null;
    });
    await entered.promise;
    let authorized = true;
    const pending = persist(
      { authProfileOverride: "openai:work", authProfileOverrideSource: "user", updatedAt: 100 },
      {
        validateCommit: () => (authorized ? undefined : "Select an account you own."),
      },
    );
    authorized = false;
    release.resolve();
    await writer;

    expect(await pending).toMatchObject({
      status: "commit-rejected",
      error: "Select an account you own.",
      entry: initialEntry,
    });
    expect(read()).toEqual(initialEntry);
  });

  it("does not restore policy fields revoked during reply processing", async () => {
    const initialEntry: SessionEntry = {
      ...baseEntry,
      thinkingLevel: "low",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
    };
    const { read, persist, replace } = fixture(initialEntry);
    const currentEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 400,
      thinkingLevel: "low",
      sendPolicy: "deny",
    };
    await replace(currentEntry);

    const result = await persist(
      { thinkingLevel: "high" },
      { skipMaintenance: true, validateCommit: () => undefined },
    );

    expect(result).toMatchObject({
      status: "current",
      entry: { ...currentEntry, thinkingLevel: "high" },
    });
    expect(result.entry?.elevatedLevel).toBeUndefined();
    expect(result.entry?.inheritedToolAllow).toBeUndefined();
    expect(read()).toEqual(result.entry);
  });

  it.each(["rotated", "deleted", "archived"] as const)("rejects %s sessions", async (state) => {
    const initial =
      state === "archived"
        ? { ...baseEntry, modelOverride: "gpt-5.5" }
        : state === "rotated"
          ? { ...baseEntry, thinkingLevel: "low" as const }
          : baseEntry;
    const current =
      state === "deleted"
        ? undefined
        : storedEntry(
            state === "rotated"
              ? { sessionId: "session-2", thinkingLevel: "medium" }
              : { modelOverride: "gpt-5.5", archivedAt: 300 },
          );
    const { read, persist, replace } = fixture(initial);
    if (current) {
      await replace(current);
    }
    const result = await persist(state === "rotated" ? { thinkingLevel: "high" } : {}, {
      touchedFields: state === "archived" ? ["modelOverride"] : undefined,
    });
    const errors = {
      rotated: "changed while starting work. Retry.",
      deleted: "was deleted while starting work. Retry.",
      archived: "is archived. Restore it before starting new work.",
    };
    expect(result).toEqual({
      status: "lifecycle-invalidated",
      error: `Session "${sessionKey}" ${errors[state]}`,
      ...(current ? { entry: current } : {}),
    });
    expect(read()).toEqual(current);
  });
});
