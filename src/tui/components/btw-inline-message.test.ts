// BTW inline message tests cover compact inline status message rendering.
import { describe, expect, it } from "vitest";
import { createTuiLocalization } from "../i18n/runtime.js";
import { BtwInlineMessage } from "./btw-inline-message.js";

describe("btw inline message", () => {
  it("renders the BTW question, answer, and dismiss hint inline", () => {
    const message = new BtwInlineMessage({
      question: "what is 17 * 19?",
      text: "323",
    });

    expect(message.render(80)).toEqual([
      "",
      " BTW: what is 17 * 19?                                                          ",
      "",
      "323                                                                             ",
      " Press Enter or Esc to dismiss                                                  ",
    ]);
  });

  it("localizes owned labels while preserving question and answer text", () => {
    const message = new BtwInlineMessage(
      {
        question: "provider/model-id?",
        text: "raw answer",
      },
      createTuiLocalization({ locale: "zh-CN" }),
    );
    const rendered = message.render(80).join("\n");

    expect(rendered).toContain("顺便问：provider/model-id?");
    expect(rendered).toContain("raw answer");
    expect(rendered).toContain("按 Enter 或 Esc 关闭");
  });
});
