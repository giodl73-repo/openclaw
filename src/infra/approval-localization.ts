import {
  createCatalogSnapshot,
  createLocalizationContext,
  renderLocalizedMessage,
  validateCatalog,
  type CatalogSnapshot,
  type LocalizationContext,
  type MessageParam,
} from "@openclaw/localization-core";

const APPROVAL_ENGLISH_MESSAGES = {
  "approval.exec.title.pending": "Exec Approval Required",
  "approval.exec.title.resolved": "Exec Approval",
  "approval.exec.title.expired": "Exec Approval",
  "approval.exec.description.pending": "A command needs your approval.",
  "approval.metadata.agent": "Agent",
  "approval.metadata.cwd": "CWD",
  "approval.metadata.host": "Host",
  "approval.metadata.envOverrides": "Env Overrides",
  "approval.metadata.severity": "Severity",
  "approval.metadata.tool": "Tool",
  "approval.metadata.plugin": "Plugin",
  "approval.severity.critical": "Critical",
  "approval.severity.info": "Info",
  "approval.severity.warning": "Warning",
  "approval.action.allowOnce": "Allow Once",
  "approval.action.allowAlways": "Allow Always",
  "approval.action.deny": "Deny",
} as const;

export type ApprovalMessageKey = keyof typeof APPROVAL_ENGLISH_MESSAGES;
export type ApprovalMessageRenderer = (
  key: ApprovalMessageKey,
  params?: Readonly<Record<string, MessageParam>>,
) => string;

const APPROVAL_ENGLISH_SNAPSHOT = createCatalogSnapshot({
  catalogRevision: "approval-runtime:en:1",
  catalogs: { en: APPROVAL_ENGLISH_MESSAGES },
});

function hasCompleteApprovalCatalog(snapshot: CatalogSnapshot, context: LocalizationContext) {
  if (context.locale === "en") {
    return true;
  }
  const candidate = snapshot.catalogs[context.locale];
  return (
    candidate !== undefined &&
    validateCatalog({
      namespace: "approval",
      source: APPROVAL_ENGLISH_MESSAGES,
      candidate,
    }).length === 0
  );
}

/** Creates the final-boundary renderer used by channel approval view models. */
export function createApprovalMessageRenderer(options?: {
  context?: LocalizationContext;
  snapshot?: CatalogSnapshot;
}): ApprovalMessageRenderer {
  const context =
    options?.context ??
    createLocalizationContext({
      locale: "en",
      source: "english-default",
      audience: "operator",
    });
  const snapshot = options?.snapshot ?? APPROVAL_ENGLISH_SNAPSHOT;
  const renderContext = hasCompleteApprovalCatalog(snapshot, context)
    ? context
    : createLocalizationContext({
        locale: "en",
        source: "english-default",
        audience: "operator",
      });
  return (key, params) =>
    renderLocalizedMessage(snapshot, renderContext, {
      key,
      params,
      fallback: APPROVAL_ENGLISH_MESSAGES[key],
    });
}

export const DEFAULT_APPROVAL_MESSAGE_RENDERER = createApprovalMessageRenderer();
