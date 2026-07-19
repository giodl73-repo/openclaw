import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CommandEntrySchema } from "./commands.js";

function commandWithLocalizations(descriptionLocalizations: Record<string, string>) {
  return {
    name: "commands",
    description: "List commands",
    descriptionLocalizations,
    source: "native",
    scope: "both",
    acceptsArgs: false,
  };
}

describe("CommandEntrySchema", () => {
  it("accepts bounded locale keys", () => {
    expect(Value.Check(CommandEntrySchema, commandWithLocalizations({ "zh-CN": "列出命令" }))).toBe(
      true,
    );
  });

  it("rejects empty and oversized locale keys", () => {
    expect(Value.Check(CommandEntrySchema, commandWithLocalizations({ "": "Invalid" }))).toBe(
      false,
    );
    expect(
      Value.Check(CommandEntrySchema, commandWithLocalizations({ ["x".repeat(65)]: "Invalid" })),
    ).toBe(false);
  });
});
