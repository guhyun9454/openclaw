import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  classifyMSTeamsSendError,
  formatMSTeamsDeliveryFailureGuidance,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";

function replaySafeRetryAfterMs(error: unknown): number | undefined {
  const classification = classifyMSTeamsSendError(error);
  return classification.kind === "replay-safe" ? classification.retryAfterMs : undefined;
}

const classify = (statusCode: number) => classifyMSTeamsSendError({ statusCode });
const hint = (statusCode: number) => formatMSTeamsSendErrorHint(classify(statusCode));
const guidance = (statusCode: number) => formatMSTeamsDeliveryFailureGuidance(classify(statusCode));

describe("msteams errors", () => {
  it.each([
    [403, "auth"],
    [429, "replay-safe"],
    [504, "ambiguous"],
  ] as const)("classifies real Connector HTTP %i errors as %s", async (status, kind) => {
    const { Client: ApiClient } = await import("@microsoft/teams.api");
    let requests = 0;
    await withServer(
      (request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(status, {
          "content-type": "application/json",
          "retry-after": "2",
        });
        response.end(JSON.stringify({ error: { code: "ConnectorFailure", message: "rejected" } }));
      },
      async (baseUrl) => {
        const api = new ApiClient(baseUrl);
        const result = await api.conversations
          .activities("loopback-conversation")
          .create({ type: "message", text: "synthetic reply" })
          .then(
            () => undefined,
            (error: unknown) => classifyMSTeamsSendError(error),
          );
        expect(result).toMatchObject({ kind, statusCode: status });
        if (result?.kind === "replay-safe") {
          expect(result.retryAfterMs).toBe(2000);
        }
        expect(requests).toBe(1);
      },
    );
  });

  it("formats unknown errors", () => {
    expect(formatUnknownError("oops")).toBe("oops");
    expect(formatUnknownError(null)).toBe("null");
  });

  it("classifies auth errors", () => {
    expect(classify(401).kind).toBe("auth");
    expect(classify(403).kind).toBe("auth");
  });

  it("retains the normalized retry delay on replay-safe rate limits", () => {
    const result = classifyMSTeamsSendError({ statusCode: 429, retryAfterMs: 1500 });
    expect(result).toMatchObject({ kind: "replay-safe", statusCode: 429, retryAfterMs: 1500 });
  });

  it.each([
    { response: { headers: { "retry-after": "2 seconds" } } },
    { response: { headers: new Headers({ "retry-after": "3 seconds" }) } },
    { retryAfterMs: Number.MAX_SAFE_INTEGER + 1 },
    { response: { headers: { "retry-after": "9007199254741" } } },
    { response: { headers: new Headers({ "retry-after": "9007199254741" }) } },
  ])("rejects partial or unsafe retry delays: %j", (fields) => {
    expect(replaySafeRetryAfterMs({ statusCode: 429, ...fields })).toBeUndefined();
  });

  it("does not parse partial or fractional status codes", () => {
    expect(classifyMSTeamsSendError({ statusCode: "429oops" }).kind).toBe("unknown");
    expect(classifyMSTeamsSendError({ statusCode: 429.5 }).kind).toBe("unknown");
    expect(
      classifyMSTeamsSendError({ response: { status: "503 temporarily unavailable" } }).kind,
    ).toBe("unknown");
  });

  it.each([408, 504])("classifies HTTP %i as delivery-ambiguous", (statusCode) => {
    const classification = classify(statusCode);
    expect(classification).toMatchObject({
      kind: "ambiguous",
      source: "http",
      statusCode,
    });
    expect(hint(statusCode)).toContain("outcome is unknown");
    expect(hint(statusCode)).not.toMatch(/retry|resend/iu);
    expect(guidance(statusCode)).toContain("may already have succeeded");
    expect(guidance(statusCode)).not.toContain("Retrying later may succeed");
  });

  it("keeps model guidance aligned with replay safety", () => {
    expect(guidance(429)).toBe(
      "The request was rate-limited before delivery; retrying later may succeed.",
    );
    expect(guidance(401)).toBeUndefined();
  });

  it("classifies permanent 4xx errors", () => {
    expect(classify(400)).toMatchObject({ kind: "permanent", statusCode: 400 });
  });

  it("provides actionable hints for common cases", () => {
    expect(hint(401)).toContain("msteams");
    expect(hint(429)).toContain("throttled");
    expect(
      formatMSTeamsSendErrorHint(
        classifyMSTeamsSendError({
          statusCode: 403,
          code: "ContentStreamNotAllowed",
        }),
      ),
    ).toContain("expired the content stream");
  });

  it.each(["ETIMEDOUT"])("keeps transport %s delivery ambiguous without retry guidance", (code) => {
    const classification = classifyMSTeamsSendError(Object.assign(new Error(code), { code }));
    expect(classification).toMatchObject({
      kind: "ambiguous",
      source: "transport",
      errorCode: code,
    });
    expect(formatMSTeamsSendErrorHint(classification)).toContain("smba");
    expect(formatMSTeamsSendErrorHint(classification)).toContain("egress");
    expect(formatMSTeamsSendErrorHint(classification)).toContain("outcome is unknown");
    expect(formatMSTeamsSendErrorHint(classification)).not.toMatch(/retry|resend/iu);
  });

  it("still classifies HTTP errors as unknown when no status code and no network code", () => {
    expect(classifyMSTeamsSendError(new Error("unexpected error")).kind).toBe("unknown");
    expect(classifyMSTeamsSendError(null).kind).toBe("unknown");
  });
});
