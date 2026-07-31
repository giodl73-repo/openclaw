// Policy plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { POLICY_CLI_DESCRIPTOR } from "./src/cli-output-mode.js";
import { registerPolicyCli } from "./src/cli.js";
import { registerPolicyDoctorChecks } from "./src/doctor/register.js";

export {
  buildPolicySettingsConstraints,
  type PolicySettingsConstraint,
  type PolicySettingsConstraintsReport,
} from "./src/settings-constraints.js";

export default definePluginEntry({
  id: "policy",
  name: "Policy",
  description: "Adds policy-backed doctor checks for workspace conformance.",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        registerPolicyCli(program);
      },
      {
        descriptors: [POLICY_CLI_DESCRIPTOR],
      },
    );
    registerPolicyDoctorChecks();
  },
});
