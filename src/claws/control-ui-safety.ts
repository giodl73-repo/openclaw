import { digestClawValue } from "./digest.js";
import type { ClawDiagnostic, ClawManifest, ClawOpenClawProfile } from "./types.js";

/** Admin confirmation uses the canonical plan; plugin consent remains independently required. */
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
  if (paths.length === 0) {
    return plan;
  }
  const blockers: ClawDiagnostic[] = [
    ...plan.blockers,
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
