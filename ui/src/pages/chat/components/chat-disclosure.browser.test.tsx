import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { MessageGroup } from "./chat-message-group-view.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { RawOutputToggle } from "./chat-tool-content.solid.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
let container: HTMLDivElement;
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  container?.remove();
});

describe.runIf(browserMode)("chat disclosure activation", () => {
  it("keeps disclosure chrome unselectable and its content selectable across pointer and keyboard activation", async () => {
    container = document.body.appendChild(document.createElement("div"));
    const group = createMessageGroup(
      { role: "assistant", content: "Copyable explanation." },
      "assistant",
    );
    mountSolid(
      () => (
        <>
          <MessageGroup group={group} options={{ showReasoning: false }} />
          <openclaw-chat-tool-raw>
            <RawOutputToggle text="Copyable output" />
          </openclaw-chat-tool-raw>
        </>
      ),
      { container },
    );
    await settleToolBridges(container);
    const button = container.querySelector<HTMLButtonElement>(".chat-inline-disclosure")!;
    const label = button.querySelector("span")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.dblClick(label);
    expect(window.getSelection()?.toString()).toBe("");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(label);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard(" ");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(button.matches(":focus-visible")).toBe(true);
    await userEvent.dblClick(container.querySelector<HTMLElement>(".chat-text p")!);
    expect(window.getSelection()?.toString()).not.toBe("");
    window.getSelection()?.removeAllRanges();
    await userEvent.dblClick(
      container.querySelector<HTMLElement>(".chat-tool-card__raw-body code")!,
    );
    expect(window.getSelection()?.toString()).not.toBe("");
  });
});
