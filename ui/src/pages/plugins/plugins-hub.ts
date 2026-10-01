import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { renderHubTabs, type HubTabOption } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { clawsAvailable } from "../claws/access.ts";

registerPluginManagementEnglish();

export type PluginsHubTab = "plugins" | "skills" | "skill-workshop" | "claws";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

export function renderPluginsHubTabs(props: {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  gateway?: ApplicationGatewaySnapshot | null;
}) {
  const showClaws = clawsAvailable(props.gateway);
  return renderHubTabs({
    id: "plugins",
    active: props.active === "claws" && !showClaws ? null : props.active,
    tabs: [
      { value: "plugins", label: t("tabs.plugins") },
      { value: "skills", label: t("tabs.skills") },
      { value: "skill-workshop", label: t("tabs.skillWorkshop") },
      ...(showClaws ? [{ value: "claws" as const, label: t("tabs.claws") }] : []),
    ] satisfies readonly HubTabOption<PluginsHubTab>[],
    ariaLabel: t("pluginsPage.hubTablistLabel"),
    panelId: PLUGINS_HUB_PANEL_ID,
    className: "plugins-tabs",
    onSelect: props.onSelect,
  });
}
