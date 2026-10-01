import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("claws"),
  component: () =>
    import("./claws-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-claws-page></openclaw-claws-page>`,
    })),
});
