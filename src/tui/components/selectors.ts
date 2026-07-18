// Selector components adapt Pi TUI list controls for OpenClaw settings.
import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { TUI_ENGLISH_LOCALIZATION, type TuiLocalization } from "../i18n/runtime.js";
import {
  filterableSelectListTheme,
  searchableSelectListTheme,
  settingsListTheme,
} from "../theme/theme.js";
import { FilterableSelectList, type FilterableSelectItem } from "./filterable-select-list.js";
import { SearchableSelectList, type SearchableSelectItem } from "./searchable-select-list.js";

/** Creates a themed searchable select list for TUI overlays. */
export function createSearchableSelectList(
  items: SearchableSelectItem[],
  maxVisible = 7,
  localization: TuiLocalization = TUI_ENGLISH_LOCALIZATION,
) {
  return new SearchableSelectList(items, maxVisible, searchableSelectListTheme, {
    searchPrompt: localization.t("tui.selector.searchPrompt"),
    noMatches: localization.t("tui.selector.noMatches"),
  });
}

/** Creates a themed filterable select list for TUI overlays. */
export function createFilterableSelectList(
  items: FilterableSelectItem[],
  maxVisible = 7,
  localization: TuiLocalization = TUI_ENGLISH_LOCALIZATION,
) {
  return new FilterableSelectList(items, maxVisible, filterableSelectListTheme, {
    filterPrompt: localization.t("tui.selector.filterPrompt"),
  });
}

/** Creates a themed settings list with change and cancel callbacks. */
export function createSettingsList(
  items: SettingItem[],
  onChange: (id: string, value: string) => void,
  onCancel: () => void,
  maxVisible = 7,
) {
  return new SettingsList(items, maxVisible, settingsListTheme, onChange, onCancel);
}
