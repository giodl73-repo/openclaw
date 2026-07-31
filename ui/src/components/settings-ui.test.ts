/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderSettingsSegmented,
  renderSettingsToggleRow,
  settingsConstraintBlocksValue,
} from "./settings-ui.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
});

describe("settings constraints", () => {
  it("checks allowed and denied values", () => {
    expect(settingsConstraintBlocksValue(undefined, "full")).toBe(false);
    expect(settingsConstraintBlocksValue({ allowedValues: ["deny", "allowlist"] }, "full")).toBe(
      true,
    );
    expect(settingsConstraintBlocksValue({ deniedValues: ["remote"] }, "remote")).toBe(true);
    expect(settingsConstraintBlocksValue({ allowedValues: [false] }, true)).toBe(true);
    expect(settingsConstraintBlocksValue({ state: "disabled" }, "sandbox")).toBe(true);
    expect(settingsConstraintBlocksValue({ state: "readOnly" }, "sandbox")).toBe(true);
  });

  it("lets a violating toggle move back to the allowed value", () => {
    const onChange = vi.fn();
    render(
      renderSettingsToggleRow({
        title: "Elevated tools",
        checked: true,
        constraint: {
          allowedValues: [false],
          reason: "Policy requires elevated tools to stay disabled.",
        },
        onChange,
      }),
      container,
    );

    const row = container.querySelector<HTMLElement>(".settings-row--toggle");
    const toggle = container.querySelector("wa-switch");

    expect(row?.getAttribute("title")).toBe("Policy requires elevated tools to stay disabled.");
    expect(toggle?.hasAttribute("disabled")).toBe(false);

    row?.click();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("blocks a toggle from moving into a denied value", () => {
    const onChange = vi.fn();
    render(
      renderSettingsToggleRow({
        title: "Elevated tools",
        checked: false,
        constraint: { allowedValues: [false] },
        onChange,
      }),
      container,
    );

    container.querySelector<HTMLElement>(".settings-row--toggle")?.click();

    expect(container.querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables segmented options that policy denies", () => {
    render(
      renderSettingsSegmented({
        value: "sandbox",
        options: [
          { value: "sandbox", label: "Sandbox" },
          { value: "gateway", label: "Gateway" },
          { value: "node", label: "Node" },
        ],
        constraint: { allowedValues: ["sandbox", "gateway"] },
        onChange: vi.fn(),
      }),
      container,
    );

    const radios = [...container.querySelectorAll("wa-radio")];
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
      "sandbox",
      "gateway",
      "node",
    ]);
    expect(radios[0]?.hasAttribute("disabled")).toBe(false);
    expect(radios[1]?.hasAttribute("disabled")).toBe(false);
    expect(radios[2]?.hasAttribute("disabled")).toBe(true);
  });
});
