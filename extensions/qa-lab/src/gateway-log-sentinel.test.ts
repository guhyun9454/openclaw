import { describe, expect, it } from "vitest";
import {
  assertNoGatewayLogSentinels,
  extractGatewayMessageText,
  formatGatewayLogSentinelSummary,
  scanDirectReplyTranscriptSentinels,
  scanGatewayLogSentinels,
} from "./gateway-log-sentinel.js";

function directReply(content: unknown[]) {
  return scanDirectReplyTranscriptSentinels(
    [
      { role: "assistant", content },
      { role: "assistant", content: "Sent." },
    ]
      .map((message) => JSON.stringify({ message }))
      .join("\n"),
  );
}

describe("gateway log sentinels", () => {
  it("extracts message text from tool result shapes", () => {
    expect(
      extractGatewayMessageText({
        content: [
          "  plain  ",
          " ",
          null,
          { type: "ToOl_ReSuLt", content: " nested " },
          { type: "OUTPUT_TEXT", content: "output" },
          { type: "unknown", text: " priority ", content: "ignored" },
        ],
      }),
    ).toBe("plain\nnested\noutput\npriority");
  });

  it("classifies May 13 beta.5 operational failure signatures", () => {
    const signatures = [
      ["plugin-hook-failure", "plugin before_prompt_build hook failed: TypeError: boom"],
      ["plugin-hook-failure", "plugin before_tool_call crashed while evaluating policy"],
      ["plugin-contract-error", "plugin manifest invalid: missing contracts.tools registration"],
      ["plugin-contract-error", "[plugins] plugin must declare contracts.tools for: runtime_tool"],
      ["codex-app-server-timeout", "codex app-server attempt timed out after 180000ms"],
      ["stalled-agent-run", "codex_app_server progress stalled for run abc123"],
      ["cron-model-allowlist", "cron payload model is not in model allowlist"],
      ["live-quota-or-subscription", "OpenAI quota exceeded for live-frontier request"],
    ];
    const findings = scanGatewayLogSentinels(signatures.map(([, line]) => line).join("\n"));
    expect(findings.map(({ kind }) => kind)).toEqual(signatures.map(([kind]) => kind));
    expect(findings[0]).toMatchObject({
      verdict: "qa-harness-bug",
      owner: "plugin",
      productImpact: "P1",
    });
    expect(findings.at(-1)).toMatchObject({
      verdict: "environment-blocked",
      owner: "environment",
      productImpact: "P4",
    });
  });

  it("classifies channel final reply delivery failures without block-reply noise", () => {
    const findings = scanGatewayLogSentinels(
      [
        "2026-10-11T07:57:01.932+00:00 [telegram] final reply failed: SqliteWorkerError: Session actor version changed before command admission",
        "[tlon] final reply failed after 812ms: Error: socket closed",
        "msteams block reply failed: Error: throttled",
      ].join("\n"),
    );

    expect(findings).toMatchObject(
      [1, 2].map((line) => ({
        kind: "final-reply-delivery-failure",
        line,
        verdict: "product-bug",
        owner: "openclaw-routing",
      })),
    );
  });

  it("honors log cursors while preserving absolute line numbers", () => {
    const prefix = "safe line\n";
    const findings = scanGatewayLogSentinels(`${prefix}codex app-server attempt timed out`, {
      since: prefix.length,
    });

    expect(findings).toMatchObject([
      {
        kind: "codex-app-server-timeout",
        line: 2,
      },
    ]);
  });

  it("throws actionable summaries for product and environment failures", () => {
    expect(() => assertNoGatewayLogSentinels("codex_app_server progress stalled")).toThrow(
      "stalled-agent-run",
    );
    expect(() => assertNoGatewayLogSentinels("OpenAI quota exceeded")).toThrow(
      "live-quota-or-subscription",
    );
    expect(formatGatewayLogSentinelSummary(scanGatewayLogSentinels("OpenAI quota exceeded"))).toBe(
      "live-quota-or-subscription@1 environment-blocked owner=environment: OpenAI quota exceeded",
    );
  });

  it("detects direct reply self-message transcripts separately from gateway logs", () => {
    expect(
      directReply([
        {
          type: "tool_use",
          name: "message",
          input: { action: "send", conversationId: "qa-operator", text: "hello" },
        },
      ]),
    ).toMatchObject([
      {
        kind: "direct-reply-self-message",
        verdict: "product-bug",
        owner: "openclaw-routing",
      },
    ]);
  });

  it.each([
    [{ action: "send", target: "current", text: "hello" }, true],
    ['{"action":"send","target":"current","text":"hello"}', true],
    ['{"action":"send","target":"other-chat"}', false],
    [null, false],
    [[], false],
    ["null", false],
    ["[]", false],
    ["42", false],
    ['"text"', false],
    [" ", false],
    ["{", false],
  ])("classifies function_call message arguments %j", (args, shouldFind) => {
    const findings = directReply([
      {
        type: "function_call",
        name: "message",
        arguments: args,
      },
    ]);

    expect(findings.map((finding) => finding.kind)).toEqual(
      shouldFind ? ["direct-reply-self-message"] : [],
    );
  });
});
