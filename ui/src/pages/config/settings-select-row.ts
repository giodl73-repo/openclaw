// Shared labeled select rendering for compact Control UI preference rows.
import { html } from "lit";
import {
  renderSettingsRow,
  settingsConstraintBlocksValue,
  settingsConstraintTitle,
  type SettingsConstraint,
} from "../../components/settings-ui.ts";

export function renderSettingsSelectRow<T extends string>(params: {
  title: string;
  value: T;
  setting: "send-shortcut" | "follow-up-mode" | "catalog-open-target";
  options: ReadonlyArray<{ value: T; label: string }>;
  constraint?: SettingsConstraint;
  onChange: (value: string) => void;
}) {
  const title = settingsConstraintTitle(params.constraint);
  return renderSettingsRow({
    title: params.title,
    control: html`
      <select
        class="settings-select"
        ?data-settings-send-shortcut=${params.setting === "send-shortcut"}
        ?data-settings-follow-up-mode=${params.setting === "follow-up-mode"}
        ?data-settings-catalog-open-target=${params.setting === "catalog-open-target"}
        aria-label=${params.title}
        title=${title ?? ""}
        .value=${params.value}
        @change=${(event: Event) => {
          const select = event.currentTarget as HTMLSelectElement;
          if (settingsConstraintBlocksValue(params.constraint, select.value)) {
            select.value = params.value;
            return;
          }
          params.onChange(select.value);
        }}
      >
        ${params.options.map(
          (option) => html`
            <option
              value=${option.value}
              ?selected=${params.value === option.value}
              ?disabled=${settingsConstraintBlocksValue(params.constraint, option.value)}
            >
              ${option.label}
            </option>
          `,
        )}
      </select>
    `,
  });
}
