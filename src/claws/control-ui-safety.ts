import { digestClawValue } from "./digest.js";
import type { ClawDiagnostic, ClawManifest, ClawOpenClawProfile } from "./types.js";

/** Exact-plan integrity cannot substitute for disclosure of effective permissions. */
export function addClawControlUiSafetyBlockers<
  T extends { blockers: ClawDiagnostic[]; planIntegrity: string },
>(plan: T, loaded: { manifest: ClawManifest; openClawProfile?: ClawOpenClawProfile }): T {
  const paths = [
    ...loaded.manifest.packages.flatMap((pkg, index) =>
      pkg.kind === "plugin" ? [`$.packages[${index}]`] : [],
    ),
    ...(loaded.openClawProfile?.extensions ?? []).map(
      (_, index) => `$.profiles.openclaw.extensions[${index}]`,
    ),
  ];
  const blockers: ClawDiagnostic[] = [
    ...plan.blockers,
    {
      level: "error",
      phase: "plan",
      code: "capability_disclosure_unavailable",
      path: "$.agent",
      // Even an empty profile inherits permissions that this preview does not yet disclose.
      message:
        "Applying Claws is unavailable until the preview discloses effective agent permissions.",
    },
    ...paths.map((path): ClawDiagnostic => ({
      level: "error",
      phase: "plan",
      code: "plugin_consent_unavailable",
      path,
      message: "Plugin capability consent is not available through the Claws Control UI.",
    })),
  ];
  return {
    ...plan,
    blockers,
    planIntegrity: digestClawValue({ canonicalPlanIntegrity: plan.planIntegrity, blockers }),
  };
}
