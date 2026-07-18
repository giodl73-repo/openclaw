import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { ChatLog } from "./components/chat-log.js";
import { createTuiLocalization } from "./i18n/runtime.js";
import { addBlockedChatSubmitNotice } from "./tui-busy-notice.js";

describe("addBlockedChatSubmitNotice", () => {
  it("coalesces repeated busy submit notices", () => {
    const chatLog = new ChatLog(20);

    addBlockedChatSubmitNotice(chatLog);
    addBlockedChatSubmitNotice(chatLog);
    addBlockedChatSubmitNotice(chatLog);

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain(
      "agent is busy — press Esc to abort before sending a new message x3",
    );
  });

  it("localizes the busy notice", () => {
    const chatLog = new ChatLog(20);

    addBlockedChatSubmitNotice(chatLog, createTuiLocalization({ locale: "zh-CN" }));

    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain(
      "代理正忙——请按 Esc 中止后再发送新消息",
    );
  });
});
