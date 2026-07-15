// Msteams API module exposes the plugin public contract.
export { msteamsPlugin } from "./src/channel.js";
export * from "./contract-api.js";
export { createMSTeamsSetupWizardBase, msteamsSetupAdapter } from "./src/setup-core.js";
export { msteamsSetupWizard, openDelegatedOAuthUrl } from "./src/setup-surface.js";
