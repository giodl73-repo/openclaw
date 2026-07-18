import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { createTuiLocalization } from "../i18n/runtime.js";
import { ToolExecutionComponent } from "./tool-execution.js";

describe("ToolExecutionComponent localization", () => {
  it("localizes owned status and placeholders while preserving tool output literals", () => {
    const component = new ToolExecutionComponent(
      "read_file",
      { path: "C:\\workspace\\literal.txt" },
      createTuiLocalization({ locale: "zh-CN" }),
    );

    let rendered = normalizeTestText(component.render(120).join("\n"));
    expect(rendered).toContain("Read File（运行中）");
    expect(rendered).toContain("C:\\workspace\\literal.txt");

    component.setResult({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          bytes: 2048,
          omitted: true,
        },
        { type: "text", text: "provider/model-id raw output" },
      ],
    });
    rendered = normalizeTestText(component.render(120).join("\n"));

    expect(rendered).toContain("[image/png 2kb（已省略）]");
    expect(rendered).toContain("provider/model-id raw output");
  });
});
