import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount: vi.fn(),
  listGoogleChatAccountIds: vi.fn(),
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./message-tool-api.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveGoogleChatAccount.mockReturnValue({
      accountId: "default",
      enabled: true,
      credentialSource: "service-account",
      config: { groupPolicy: "open", dmPolicy: "open" },
    });
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./api.js");
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  function send(params: Record<string, unknown>) {
    return googlechatMessageActions.handleAction({
      action: "send",
      params,
      cfg: {},
      accountId: "default",
    } as never);
  }

  function expectJsonResult(result: unknown, details: Record<string, unknown>) {
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
      details,
    });
  }

  it("supports only send actions", () => {
    expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("sends text through the resolved space", async () => {
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });

    const result = await send({ to: "spaces/AAA", message: "caption", threadId: "thread-1" });

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({
      account: resolveGoogleChatAccount.mock.results[0]?.value,
      target: "spaces/AAA",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account: resolveGoogleChatAccount.mock.results[0]?.value,
      space: "spaces/AAA",
      text: "caption",
      thread: "thread-1",
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });
  });

  it.each([
    { media: "remote.png" },
    { mediaUrls: ["remote.png"] },
    { attachments: [{ url: "remote.png" }] },
  ])("rejects local attachments %j before provider access", async (media) => {
    await expect(send({ to: "spaces/AAA", message: "caption", ...media })).rejects.toThrow(
      "Google Chat outbound attachments require remote HTTP(S) URLs.",
    );

    expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
    expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });

  it("rejects unsupported actions without provider access", async () => {
    const action = "react";

    await expect(
      googlechatMessageActions.handleAction({
        action,
        params: { messageId: "spaces/AAA/messages/msg-1", emoji: "👍" },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow(`Action ${action} is not supported for provider googlechat.`);

    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, "caption"])("sends remote media with caption %s", async (message) => {
    await send({ to: "spaces/AAA", message, media: "https://example.invalid/image.png" });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: `${message ? "caption\n\n" : ""}Attachment: https://example.invalid/image.png`,
      }),
    );
  });
});
