/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSettingsSelectRow } from "./settings-select-row.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
});

describe("settings select row constraints", () => {
  it("disables denied options and ignores disallowed changes", () => {
    const onChange = vi.fn();
    render(
      renderSettingsSelectRow({
        title: "Exec host",
        setting: "follow-up-mode",
        value: "sandbox",
        options: [
          { value: "sandbox", label: "Sandbox" },
          { value: "gateway", label: "Gateway" },
          { value: "node", label: "Node" },
        ],
        constraint: {
          allowedValues: ["sandbox", "gateway"],
          reason: "Policy only allows sandboxed hosts.",
        },
        onChange,
      }),
      container,
    );

    const select = container.querySelector("select");
    const options = [...container.querySelectorAll("option")];
    expect(select?.getAttribute("title")).toBe("Policy only allows sandboxed hosts.");
    expect(options.map((option) => option.disabled)).toEqual([false, false, true]);

    if (!select) {
      throw new Error("missing select");
    }
    select.value = "node";
    select.dispatchEvent(new Event("change"));

    expect(select.value).toBe("sandbox");
    expect(onChange).not.toHaveBeenCalled();
  });
});
