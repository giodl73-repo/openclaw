import { createCatalogSnapshot, validateCatalog } from "@openclaw/localization-core";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ENGLISH_MESSAGES,
  APPROVAL_ZH_CN_MESSAGES,
  approvalLocalizationTestHelpers,
  createApprovalMessageRenderer,
} from "./approval-localization.js";

describe("approval localization", () => {
  it("ships a complete zh-CN catalog for the whole core family", () => {
    expect(
      validateCatalog({
        namespace: "approval",
        source: APPROVAL_ENGLISH_MESSAGES,
        candidate: APPROVAL_ZH_CN_MESSAGES,
      }),
    ).toEqual([]);
  });

  it("selects an explicit recipient locale without inference", () => {
    const renderer = approvalLocalizationTestHelpers.createRenderer({
      recipientLocale: "zh-Hans",
    });

    expect(renderer.context).toEqual({
      locale: "zh-CN",
      fallbackLocales: ["en"],
      source: "explicit-recipient",
      audience: "user",
    });
    expect(Object.isFrozen(renderer)).toBe(true);
    expect(Object.isFrozen(renderer.context)).toBe(true);
    expect(renderer("approval.reply.required")).toBe("需要批准。");
  });

  it("keeps unattested non-English approval copy inactive in production", () => {
    const renderer = createApprovalMessageRenderer({ recipientLocale: "zh-CN" });

    expect(renderer.context.locale).toBe("en");
    expect(renderer("approval.reply.required")).toBe("Approval required.");
  });

  it.each(["not_a_locale", "de"])(
    "falls back to reviewed English for malformed or unsupported recipient locale %j",
    (recipientLocale) => {
      const renderer = createApprovalMessageRenderer({ recipientLocale });

      expect(renderer.context.locale).toBe("en");
      expect(renderer("approval.reply.required")).toBe("Approval required.");
      expect(renderer("approval.action.allowAlways")).toBe("Allow Always");
    },
  );

  it("uses one reviewed English renderer when the selected catalog is incomplete", () => {
    const renderer = approvalLocalizationTestHelpers.createRenderer({
      recipientLocale: "zh-CN",
      snapshot: createCatalogSnapshot({
        catalogRevision: "approval-test:incomplete",
        catalogs: {
          en: {
            ...APPROVAL_ENGLISH_MESSAGES,
            "approval.reply.required": "UNREVIEWED ENGLISH",
          },
          "zh-CN": {
            "approval.reply.required": "需要批准。",
          },
        },
      }),
    });

    expect(renderer.context).toEqual({
      locale: "en",
      fallbackLocales: [],
      source: "english-default",
      audience: "user",
    });
    expect(renderer("approval.reply.required")).toBe("Approval required.");
    expect(renderer("approval.reply.pendingCommand")).toBe("Pending command:");
  });
});
