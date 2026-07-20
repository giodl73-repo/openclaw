export const BACKUP_CONTINUITY_TARGET_LEVEL = "archived" as const;

export const BACKUP_CONTINUITY_BLOCKER_CODES = [
  "continuity.capture.partial_backup",
  "continuity.config.secret_classification_unproven",
  "continuity.credentials.auth_profile_state_unclassified",
  "continuity.credentials.auth_profile_store_included",
  "continuity.credentials.oauth_included",
  "continuity.sessions.legacy_transcripts_excluded",
  "continuity.workspace.excluded",
] as const;

export type BackupContinuityBlockerCode = (typeof BACKUP_CONTINUITY_BLOCKER_CODES)[number];

export type BackupContinuityBlocker = {
  code: BackupContinuityBlockerCode;
  count: number;
};

export type BackupContinuityAssessment = {
  targetLevel: typeof BACKUP_CONTINUITY_TARGET_LEVEL;
  eligible: false;
  blockers: BackupContinuityBlocker[];
};

export type BackupContinuityEvidence = {
  onlyConfig: boolean;
  includeWorkspace: boolean;
  excludesLegacySessionTranscripts: boolean;
  oauthCredentialsInCaptureScope: boolean;
  authProfileStoreRowCount: number;
  authProfileStateRowCount: number;
};

/**
 * Records why an ordinary backup must not be treated as an Archived recovery
 * point. Eligibility stays fail-closed until config secrets are classified.
 */
export function assessBackupForArchivedContinuity(
  evidence: BackupContinuityEvidence,
): BackupContinuityAssessment {
  const blockers: BackupContinuityBlocker[] = [];
  const add = (code: BackupContinuityBlockerCode, count: number) => {
    if (count > 0) {
      blockers.push({ code, count });
    }
  };

  add("continuity.capture.partial_backup", evidence.onlyConfig ? 1 : 0);
  add("continuity.workspace.excluded", evidence.includeWorkspace ? 0 : 1);
  add(
    "continuity.sessions.legacy_transcripts_excluded",
    evidence.excludesLegacySessionTranscripts ? 1 : 0,
  );
  add("continuity.credentials.oauth_included", evidence.oauthCredentialsInCaptureScope ? 1 : 0);
  add("continuity.credentials.auth_profile_store_included", evidence.authProfileStoreRowCount);
  add("continuity.credentials.auth_profile_state_unclassified", evidence.authProfileStateRowCount);

  // Ordinary backup copies the config verbatim. Schema-aware secret
  // classification is required before that artifact can satisfy continuity.
  add("continuity.config.secret_classification_unproven", 1);

  return {
    targetLevel: BACKUP_CONTINUITY_TARGET_LEVEL,
    eligible: false,
    blockers,
  };
}
