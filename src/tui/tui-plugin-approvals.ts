// Presents plugin approvals that belong to the active TUI session.
import {
  SelectList,
  Text,
  type Component,
  type OverlayHandle,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { isApprovalStaleError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import { TUI_ENGLISH_LOCALIZATION, type TuiLocalization } from "./i18n/runtime.js";
import { selectListTheme, theme } from "./theme/theme.js";
import type { TuiApprovalDecision, TuiBackend, TuiPluginApproval } from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";

type ApprovalSelector = Component & {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex?: (index: number) => void;
};

const APPROVAL_BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeApprovalText(text: string): string {
  const flattened = text.replace(APPROVAL_BIDI_CONTROL_RE, "").replace(/\s+/g, " ").trim();
  return sanitizeRenderableText(flattened);
}

class PluginApprovalPrompt implements Component {
  private readonly title: Text;
  private readonly metadata: Text;
  private readonly description: Text;
  private readonly confirmation = new Text();

  constructor(
    surfaceLabel: string,
    approval: TuiPluginApproval,
    private readonly selector: ApprovalSelector,
    localization: TuiLocalization,
  ) {
    const title = sanitizeApprovalText(approval.request.title);
    const description = sanitizeApprovalText(approval.request.description ?? "");
    const severity = approval.request.severity ?? "warning";
    const severityLabel = localization.t(
      severity === "critical"
        ? "tui.approval.severity.critical"
        : severity === "info"
          ? "tui.approval.severity.info"
          : "tui.approval.severity.warning",
    );
    const metadata = [
      localization.t("tui.approval.severity", { severity: severityLabel }),
      ...(approval.request.toolName
        ? [
            localization.t("tui.approval.tool", {
              tool: sanitizeApprovalText(approval.request.toolName),
            }),
          ]
        : []),
      ...(approval.request.pluginId
        ? [
            localization.t("tui.approval.plugin", {
              plugin: sanitizeApprovalText(approval.request.pluginId),
            }),
          ]
        : []),
    ];
    this.title = new Text(
      theme.header(localization.t("tui.approval.title", { surface: surfaceLabel, title })),
    );
    this.metadata = new Text(theme.dim(metadata.join("\n")));
    this.description = new Text(
      theme.system(description ? localization.t("tui.approval.request", { description }) : ""),
    );
  }

  setConfirmation(text: string): void {
    this.confirmation.setText(theme.accent(text));
  }

  invalidate(): void {
    this.title.invalidate();
    this.metadata.invalidate();
    this.description.invalidate();
    this.confirmation.invalidate();
    this.selector.invalidate();
  }

  render(width: number): string[] {
    const description = this.description.render(width);
    const confirmation = this.confirmation.render(width);
    return [
      ...this.title.render(width),
      ...this.metadata.render(width),
      ...(description.some((line) => line.trim()) ? description : []),
      ...(confirmation.some((line) => line.trim()) ? ["", ...confirmation] : []),
      "",
      ...this.selector.render(width),
    ];
  }

  handleInput(data: string): void {
    this.selector.handleInput?.(data);
  }
}

type ApprovalTimer = number | NodeJS.Timeout;
type ApprovalMutation = {
  version: number;
  approval: TuiPluginApproval | null;
};

type TuiPluginApprovalControllerDeps = {
  client: Pick<TuiBackend, "listPluginApprovals" | "resolvePluginApproval">;
  chatLog: {
    addSystem: (line: string) => void;
  };
  getAgentId: () => string;
  getSessionKey: () => string;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  requestRender: () => void;
  localization?: TuiLocalization;
  createSelector?: (items: SelectItem[]) => ApprovalSelector;
  nowMs?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ApprovalTimer;
  clearTimeoutFn?: (timer: ApprovalTimer) => void;
};

const DEFAULT_DECISIONS: readonly TuiApprovalDecision[] = ["allow-once", "allow-always", "deny"];

function decisionItems(localization: TuiLocalization): Record<TuiApprovalDecision, SelectItem> {
  return {
    "allow-once": {
      value: "allow-once",
      label: localization.t("tui.approval.allowOnce"),
      description: localization.t("tui.approval.allowOnceDescription"),
    },
    "allow-always": {
      value: "allow-always",
      label: localization.t("tui.approval.allowAlways"),
      description: localization.t("tui.approval.allowAlwaysDescription"),
    },
    deny: {
      value: "deny",
      label: localization.t("tui.approval.deny"),
      description: localization.t("tui.approval.denyDescription"),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDecision(value: unknown): TuiApprovalDecision | null {
  return value === "allow-once" || value === "allow-always" || value === "deny" ? value : null;
}

function parseAllowedDecisions(value: unknown): TuiApprovalDecision[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const decisions: TuiApprovalDecision[] = [];
  for (const candidate of value) {
    const decision = parseDecision(candidate);
    if (decision && !decisions.includes(decision)) {
      decisions.push(decision);
    }
  }
  return decisions.length > 0 ? decisions : undefined;
}

function parseSeverity(value: unknown): TuiPluginApproval["request"]["severity"] {
  return value === "info" || value === "warning" || value === "critical" ? value : null;
}

/** Parses the gateway event/list shape used for pending plugin approvals. */
function parseTuiPluginApproval(payload: unknown): TuiPluginApproval | null {
  if (!isRecord(payload) || !isRecord(payload.request)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const title = typeof payload.request.title === "string" ? payload.request.title.trim() : "";
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!id || !title || !createdAtMs || !expiresAtMs) {
    return null;
  }
  return {
    id,
    request: {
      title,
      description:
        typeof payload.request.description === "string" ? payload.request.description : null,
      pluginId: typeof payload.request.pluginId === "string" ? payload.request.pluginId : null,
      severity: parseSeverity(payload.request.severity),
      toolName: typeof payload.request.toolName === "string" ? payload.request.toolName : null,
      allowedDecisions: parseAllowedDecisions(payload.request.allowedDecisions),
      agentId: typeof payload.request.agentId === "string" ? payload.request.agentId : null,
      sessionKey:
        typeof payload.request.sessionKey === "string" ? payload.request.sessionKey : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

function parseResolvedApprovalId(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.id !== "string") {
    return null;
  }
  return payload.id.trim() || null;
}

function decisionLabel(decision: TuiApprovalDecision, localization: TuiLocalization): string {
  if (decision === "allow-once") {
    return localization.t("tui.approval.decision.allowedOnce");
  }
  if (decision === "allow-always") {
    return localization.t("tui.approval.decision.alwaysAllowed");
  }
  return localization.t("tui.approval.decision.denied");
}

function approvalSurfaceLabel(approval: TuiPluginApproval, localization: TuiLocalization): string {
  return approval.request.toolName === "skill_workshop"
    ? localization.t("tui.approval.surface.workspaceSkill")
    : localization.t("tui.approval.surface.plugin");
}

/** Coordinates pending plugin approval events with the active TUI overlay. */
export function createTuiPluginApprovalController(deps: TuiPluginApprovalControllerDeps) {
  const localization = deps.localization ?? TUI_ENGLISH_LOCALIZATION;
  const itemsByDecision = decisionItems(localization);
  const createSelector =
    deps.createSelector ??
    ((items: SelectItem[]) => new SelectList(items, items.length, selectListTheme));
  const nowMs = deps.nowMs ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let queue: TuiPluginApproval[] = [];
  let activeId: string | null = null;
  let activeOverlay: OverlayHandle | null = null;
  let expiryTimer: ApprovalTimer | null = null;
  let disposed = false;
  let mutationVersion = 0;
  let refreshAgain = false;
  let refreshInFlight: Promise<void> | null = null;
  const mutations = new Map<string, ApprovalMutation>();
  const resolvingIds = new Set<string>();
  const dismissedIds = new Set<string>();

  const clearExpiryTimer = () => {
    if (expiryTimer !== null) {
      clearTimeoutFn(expiryTimer);
      expiryTimer = null;
    }
  };

  const closeActiveOverlay = () => {
    const handle = activeOverlay;
    activeOverlay = null;
    if (handle) {
      deps.closeOverlay(handle);
    }
  };

  const recordMutation = (id: string, approval: TuiPluginApproval | null) => {
    if (!refreshInFlight) {
      return;
    }
    mutationVersion += 1;
    mutations.set(id, { version: mutationVersion, approval });
  };

  const remove = (id: string, record = true) => {
    queue = queue.filter((approval) => approval.id !== id);
    dismissedIds.delete(id);
    if (record) {
      recordMutation(id, null);
    }
  };

  const add = (approval: TuiPluginApproval, record = true) => {
    queue = queue.filter((entry) => entry.id !== approval.id);
    queue.push(approval);
    queue.sort((left, right) => left.createdAtMs - right.createdAtMs);
    if (record) {
      recordMutation(approval.id, approval);
    }
  };

  const matchesActiveSession = (approval: TuiPluginApproval) => {
    const sessionKey = approval.request.sessionKey?.trim();
    if (!sessionKey || sessionKey !== deps.getSessionKey()) {
      return false;
    }
    if (sessionKey !== "global") {
      return true;
    }
    const agentId = approval.request.agentId?.trim();
    return Boolean(agentId && agentId === deps.getAgentId());
  };

  const prune = () => {
    const now = nowMs();
    for (const approval of queue.filter((entry) => entry.expiresAtMs <= now)) {
      remove(approval.id);
    }
  };

  const presentNext = () => {
    if (disposed || activeId) {
      return;
    }
    prune();
    const approval = queue.find(
      (candidate) =>
        !resolvingIds.has(candidate.id) &&
        !dismissedIds.has(candidate.id) &&
        matchesActiveSession(candidate),
    );
    if (!approval) {
      return;
    }
    activeId = approval.id;
    const surfaceLabel = approvalSurfaceLabel(approval, localization);

    const decisions = approval.request.allowedDecisions ?? DEFAULT_DECISIONS;
    const selector = createSelector(decisions.map((decision) => itemsByDecision[decision]));
    let allowDecisionArmed = false;
    let prompt: PluginApprovalPrompt | null = null;
    const denyIndex = decisions.indexOf("deny");
    let selectedDecision = denyIndex >= 0 ? decisions[denyIndex] : decisions[0];
    if (denyIndex >= 0) {
      selector.setSelectedIndex?.(denyIndex);
    }
    selector.onSelectionChange = (item) => {
      const decision = parseDecision(item.value);
      if (!decision || decision === selectedDecision) {
        return;
      }
      selectedDecision = decision;
      allowDecisionArmed = decision !== "deny";
      prompt?.setConfirmation("");
    };

    const resolve = async (decision: TuiApprovalDecision) => {
      if (activeId !== approval.id) {
        return;
      }
      clearExpiryTimer();
      activeId = null;
      resolvingIds.add(approval.id);
      closeActiveOverlay();
      deps.requestRender();
      let stale = false;
      try {
        if (!deps.client.resolvePluginApproval) {
          throw new Error(localization.t("tui.approval.resolutionUnavailable"));
        }
        const result = await deps.client.resolvePluginApproval(approval.id, decision);
        if (result?.ok === false) {
          stale = true;
        } else {
          remove(approval.id);
          deps.chatLog.addSystem(
            localization.t("tui.approval.resolved", {
              surface: surfaceLabel,
              decision: decisionLabel(decision, localization),
            }),
          );
        }
      } catch (error) {
        if (isApprovalStaleError(error)) {
          stale = true;
        } else {
          deps.chatLog.addSystem(
            localization.t("tui.approval.failed", {
              surface: surfaceLabel,
              error: formatErrorMessage(error),
            }),
          );
        }
      }
      if (stale) {
        remove(approval.id);
        deps.chatLog.addSystem(
          localization.t("tui.approval.noLongerPending", { surface: surfaceLabel }),
        );
        try {
          await refreshApprovals();
        } catch (error) {
          deps.chatLog.addSystem(
            localization.t("tui.approval.refreshFailed", {
              surface: surfaceLabel,
              error: formatErrorMessage(error),
            }),
          );
        }
      }
      resolvingIds.delete(approval.id);
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    selector.onSelect = (item) => {
      const decision = parseDecision(item.value);
      if (!decision) {
        return;
      }
      if (decision !== "deny" && !allowDecisionArmed) {
        allowDecisionArmed = true;
        prompt?.setConfirmation(localization.t("tui.approval.confirm", { decision: item.label }));
        deps.requestRender();
        return;
      }
      void resolve(decision);
    };
    selector.onCancel = () => {
      const deny = decisions.includes("deny") ? "deny" : null;
      if (deny) {
        void resolve(deny);
        return;
      }
      clearExpiryTimer();
      dismissedIds.add(approval.id);
      activeId = null;
      closeActiveOverlay();
      deps.chatLog.addSystem(localization.t("tui.approval.dismissed", { surface: surfaceLabel }));
      presentNext();
      deps.requestRender();
    };
    const timer = setTimeoutFn(
      () => {
        if (activeId !== approval.id) {
          return;
        }
        expiryTimer = null;
        activeId = null;
        remove(approval.id);
        closeActiveOverlay();
        deps.chatLog.addSystem(localization.t("tui.approval.expired", { surface: surfaceLabel }));
        presentNext();
        deps.requestRender();
      },
      Math.max(1, approval.expiresAtMs - nowMs()),
    );
    expiryTimer = timer;
    if (typeof timer !== "number") {
      timer.unref?.();
    }
    prompt = new PluginApprovalPrompt(surfaceLabel, approval, selector, localization);
    activeOverlay = deps.openOverlay(prompt);
    deps.requestRender();
  };

  const applySnapshot = (approvals: TuiPluginApproval[], startedAtVersion: number) => {
    const next = new Map(approvals.map((approval) => [approval.id, approval]));
    for (const [id, mutation] of mutations) {
      if (mutation.version <= startedAtVersion) {
        mutations.delete(id);
        continue;
      }
      if (mutation.approval) {
        next.set(id, mutation.approval);
      } else {
        next.delete(id);
      }
    }
    for (const id of dismissedIds) {
      if (!next.has(id)) {
        dismissedIds.delete(id);
      }
    }
    queue = [...next.values()].toSorted((left, right) => left.createdAtMs - right.createdAtMs);
  };

  const refreshOnce = async () => {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    const startedAtVersion = mutationVersion;
    const payload = await deps.client.listPluginApprovals();
    if (disposed || !Array.isArray(payload)) {
      return;
    }
    const approvals: TuiPluginApproval[] = [];
    for (const entry of payload) {
      const approval = parseTuiPluginApproval(entry);
      if (approval) {
        approvals.push(approval);
      }
    }
    applySnapshot(approvals, startedAtVersion);
    if (activeId && !queue.some((approval) => approval.id === activeId)) {
      clearExpiryTimer();
      activeId = null;
      closeActiveOverlay();
    }
    presentNext();
    deps.requestRender();
  };

  const refreshApprovals = async (): Promise<void> => {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    if (refreshInFlight) {
      refreshAgain = true;
      return await refreshInFlight;
    }
    refreshInFlight = (async () => {
      do {
        refreshAgain = false;
        await refreshOnce();
      } while (refreshAgain);
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  return {
    handleEvent(event: string, payload: unknown) {
      if (disposed) {
        return;
      }
      if (event === "plugin.approval.requested") {
        const approval = parseTuiPluginApproval(payload);
        if (approval) {
          add(approval);
          presentNext();
        }
        return;
      }
      if (event !== "plugin.approval.resolved" && event !== "plugin.approval.removed") {
        return;
      }
      const id = parseResolvedApprovalId(payload);
      if (!id) {
        return;
      }
      remove(id);
      resolvingIds.delete(id);
      if (activeId === id) {
        clearExpiryTimer();
        activeId = null;
        closeActiveOverlay();
      }
      presentNext();
      deps.requestRender();
    },
    refresh: refreshApprovals,
    sessionChanged() {
      if (disposed) {
        return;
      }
      const activeApproval = activeId
        ? queue.find((approval) => approval.id === activeId)
        : undefined;
      if (activeApproval && !matchesActiveSession(activeApproval)) {
        clearExpiryTimer();
        activeId = null;
        closeActiveOverlay();
        deps.requestRender();
      }
      presentNext();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearExpiryTimer();
      queue = [];
      dismissedIds.clear();
      mutations.clear();
      resolvingIds.clear();
      if (activeId) {
        activeId = null;
        closeActiveOverlay();
        deps.requestRender();
      }
    },
  };
}
