import { describe, expect, it } from "vitest";
import { assessBackupForArchivedContinuity } from "./backup-assessment.js";

describe("backup continuity assessment", () => {
  it("keeps an otherwise complete ordinary backup blocked on config classification", () => {
    expect(
      assessBackupForArchivedContinuity({
        onlyConfig: false,
        includeWorkspace: true,
        excludesLegacySessionTranscripts: false,
        oauthCredentialsInCaptureScope: false,
        authProfileStoreRowCount: 0,
        authProfileStateRowCount: 0,
      }),
    ).toEqual({
      targetLevel: "archived",
      eligible: false,
      blockers: [{ code: "continuity.config.secret_classification_unproven", count: 1 }],
    });
  });

  it("reports excluded transcript and credential capture policies", () => {
    expect(
      assessBackupForArchivedContinuity({
        onlyConfig: false,
        includeWorkspace: true,
        excludesLegacySessionTranscripts: true,
        oauthCredentialsInCaptureScope: true,
        authProfileStoreRowCount: 2,
        authProfileStateRowCount: 1,
      }).blockers,
    ).toEqual([
      { code: "continuity.sessions.legacy_transcripts_excluded", count: 1 },
      { code: "continuity.credentials.oauth_included", count: 1 },
      { code: "continuity.credentials.auth_profile_store_included", count: 2 },
      { code: "continuity.credentials.auth_profile_state_unclassified", count: 1 },
      { code: "continuity.config.secret_classification_unproven", count: 1 },
    ]);
  });

  it("identifies intentionally partial backup plans", () => {
    expect(
      assessBackupForArchivedContinuity({
        onlyConfig: true,
        includeWorkspace: false,
        excludesLegacySessionTranscripts: false,
        oauthCredentialsInCaptureScope: false,
        authProfileStoreRowCount: 0,
        authProfileStateRowCount: 0,
      }).blockers,
    ).toEqual([
      { code: "continuity.capture.partial_backup", count: 1 },
      { code: "continuity.workspace.excluded", count: 1 },
      { code: "continuity.config.secret_classification_unproven", count: 1 },
    ]);
  });
});
