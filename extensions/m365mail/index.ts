import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "m365mail",
  name: "Microsoft 365 Email",
  description: "Native Microsoft 365 email channel plugin for OpenClaw",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "m365MailPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setM365MailRuntime",
  },
});
