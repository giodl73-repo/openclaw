import { html, nothing } from "lit";
import type {
  ClawCatalogDetail,
  ClawConfiguredPermissions,
  ClawLifecyclePlanResult,
  ClawScheduledJobDisclosure,
  ClawStatusEntry,
  ClawsDoctorResult,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatDurationCompact, formatDurationHuman } from "../../lib/format-duration.ts";
import { buildClawApplyRequest, type PendingClawOperation } from "./lifecycle-request.ts";

registerPluginManagementEnglish();

function renderScheduledDeclaration(
  job: NonNullable<ClawScheduledJobDisclosure["jobs"][number]["proposed"]>,
) {
  return html`
    <dt>${t("clawsPage.scheduledJobs.cron")}</dt>
    <dd><code>${job.schedule.cron}</code></dd>
    <dt>${t("clawsPage.scheduledJobs.timezone")}</dt>
    <dd>${job.schedule.timezone}</dd>
    <dt>${t("clawsPage.scheduledJobs.session")}</dt>
    <dd>${t(`clawsPage.scheduledJobs.sessions.${job.session}`)}</dd>
    <dt>${t("clawsPage.scheduledJobs.delivery")}</dt>
    <dd>${t(`clawsPage.scheduledJobs.deliveries.${job.delivery}`)}</dd>
  `;
}

function renderScheduledJobs(disclosure: ClawScheduledJobDisclosure | undefined) {
  return html`<section aria-label=${t("clawsPage.scheduledJobs.title")}>
    <h3>${t("clawsPage.scheduledJobs.title")}</h3>
    <p class="muted">${t("clawsPage.scheduledJobs.coverage")}</p>
    <p class="muted">${t("clawsPage.scheduledJobs.deliveryCaveat")}</p>
    ${
      !disclosure
        ? html`<p>${t("clawsPage.scheduledJobs.unavailable")}</p>`
        : !disclosure.jobs.length
          ? html`<p>${t("clawsPage.scheduledJobs.empty")}</p>`
          : disclosure.jobs.map(
              (job) => html`<section class="claws-permission-snapshot" aria-label=${job.id}>
                <h4>${job.id}</h4>
                <dl class="claws-facts">
                  <dt>${t("clawsPage.scheduledJobs.action")}</dt>
                  <dd>${t(`clawsPage.scheduledJobs.actions.${job.action}`)}</dd>
                  <dt>${t("clawsPage.scheduledJobs.blocked")}</dt>
                  <dd>
                    ${t(job.blocked ? "clawsPage.permissions.yes" : "clawsPage.permissions.no")}
                  </dd>
                </dl>
                <section aria-label=${t("clawsPage.scheduledJobs.recorded", { id: job.id })}>
                  <h5>${t("clawsPage.scheduledJobs.recorded", { id: job.id })}</h5>
                  ${
                    job.recorded?.state === "declared"
                      ? html`<dl class="claws-facts">
                          ${renderScheduledDeclaration(job.recorded.job)}
                          <dt>${t("clawsPage.scheduledJobs.provenanceStatus")}</dt>
                          <dd>${t(`clawsPage.scheduledJobs.statuses.${job.recorded.status}`)}</dd>
                          <dt>${t("clawsPage.scheduledJobs.schedulerIdRecorded")}</dt>
                          <dd>
                            ${t(job.recorded.schedulerIdRecorded ? "clawsPage.permissions.yes" : "clawsPage.permissions.no")}
                          </dd>
                        </dl>`
                      : html`<p>
                          ${t(job.recorded ? "clawsPage.scheduledJobs.unresolvedRecorded" : "clawsPage.scheduledJobs.noRecorded")}
                        </p>`
                  }
                </section>
                <section aria-label=${t("clawsPage.scheduledJobs.proposed", { id: job.id })}>
                  <h5>${t("clawsPage.scheduledJobs.proposed", { id: job.id })}</h5>
                  ${job.proposed ? html`<dl class="claws-facts">${renderScheduledDeclaration(job.proposed)}</dl>` : html`<p>${t("clawsPage.scheduledJobs.noProposed")}</p>`}
                </section>
              </section>`,
            )
    }
  </section>`;
}

function renderConfiguredPermissions(snapshot: ClawConfiguredPermissions, label: string) {
  const memory = snapshot.memorySearch;
  const targets = snapshot.subagentTargets;
  const memoryTitle = t("clawsPage.permissions.memoryTitle", { snapshot: label });
  const subagentTitle = t("clawsPage.permissions.subagentTitle", { snapshot: label });
  const interval =
    snapshot.heartbeat.intervalMs === null
      ? t(
          snapshot.heartbeat.enabled
            ? "clawsPage.permissions.notResolved"
            : "clawsPage.permissions.notScheduled",
        )
      : (formatDurationCompact(snapshot.heartbeat.intervalMs) ??
        formatDurationHuman(snapshot.heartbeat.intervalMs));
  const identifiers = (values: string[]) =>
    values.length
      ? html`<ul class="claws-permission-tools">
          ${values.map((value) => html`<li><code>${value}</code></li>`)}
        </ul>`
      : t("clawsPage.permissions.noneListed");
  return html`
    <section class="claws-permission-snapshot" aria-label=${label}>
      <h4>${label}</h4>
      <dl class="claws-facts">
        <dt>${t("clawsPage.permissions.allowed")}</dt>
        <dd>${identifiers(snapshot.tools.allowed)}</dd>
        <dt>${t("clawsPage.permissions.excluded")}</dt>
        <dd>${identifiers(snapshot.tools.excluded)}</dd>
        <dt>${t("clawsPage.permissions.sandboxMode")}</dt>
        <dd>${t(`clawsPage.permissions.modes.${snapshot.sandbox.mode}`)}</dd>
        <dt>${t("clawsPage.permissions.sandboxScope")}</dt>
        <dd>${t(`clawsPage.permissions.scopes.${snapshot.sandbox.scope}`)}</dd>
        <dt>${t("clawsPage.permissions.sandboxAccess")}</dt>
        <dd>${t(`clawsPage.permissions.access.${snapshot.sandbox.workspaceAccess}`)}</dd>
        <dt>${t("clawsPage.permissions.sandboxBackend")}</dt>
        <dd>${t(`clawsPage.permissions.backends.${snapshot.sandbox.backend}`)}</dd>
        <dt>${t("clawsPage.permissions.filesystem")}</dt>
        <dd>
          ${t(snapshot.filesystem.workspaceOnly ? "clawsPage.permissions.workspaceOnly" : "clawsPage.permissions.notWorkspaceOnly")}
        </dd>
        <dt>${t("clawsPage.permissions.heartbeat")}</dt>
        <dd>
          ${t(snapshot.heartbeat.enabled ? "clawsPage.permissions.enabled" : "clawsPage.permissions.disabled")}
        </dd>
        <dt>${t("clawsPage.permissions.interval")}</dt>
        <dd>${interval}</dd>
      </dl>
      <section aria-label=${memoryTitle}>
        <h5>${memoryTitle}</h5>
        <dl class="claws-facts">
          <dt>${t("clawsPage.permissions.memoryState")}</dt>
          <dd>
            ${t(memory.state === "configured" ? "clawsPage.permissions.configured" : memory.state === "disabled" ? "clawsPage.permissions.disabled" : "clawsPage.permissions.memoryUnresolved")}
          </dd>
          ${
            memory.state === "configured"
              ? html`
                  <dt>${t("clawsPage.permissions.rememberAcrossConversations")}</dt>
                  <dd>
                    ${t(memory.rememberAcrossConversations ? "clawsPage.permissions.enabled" : "clawsPage.permissions.disabled")}
                  </dd>
                  <dt>${t("clawsPage.permissions.sessionMemory")}</dt>
                  <dd>
                    ${t(memory.sessionMemory ? "clawsPage.permissions.enabled" : "clawsPage.permissions.disabled")}
                  </dd>
                  <dt>${t("clawsPage.permissions.indexedSources")}</dt>
                  <dd>
                    ${memory.indexedSources.map((source) => t(`clawsPage.permissions.memorySources.${source}`)).join(", ") || t("clawsPage.permissions.noneListed")}
                  </dd>
                  <dt>${t("clawsPage.permissions.searchSources")}</dt>
                  <dd>
                    ${memory.searchSources.map((source) => t(`clawsPage.permissions.memorySources.${source}`)).join(", ") || t("clawsPage.permissions.noneListed")}
                  </dd>
                  <dt>${t("clawsPage.permissions.extraPathCount")}</dt>
                  <dd>${memory.extraPathCount}</dd>
                `
              : nothing
          }
        </dl>
      </section>
      <section aria-label=${subagentTitle}>
        <h5>${subagentTitle}</h5>
        <dl class="claws-facts">
          <dt>${t("clawsPage.permissions.explicitAgentIds")}</dt>
          <dd>${identifiers(targets.explicitAgentIds)}</dd>
          <dt>${t("clawsPage.permissions.allowAnyConfiguredAgent")}</dt>
          <dd>
            ${t(targets.allowAnyConfiguredAgent ? "clawsPage.permissions.yes" : "clawsPage.permissions.no")}
          </dd>
          <dt>${t("clawsPage.permissions.implicitSelfAllowed")}</dt>
          <dd>
            ${t(targets.implicitSelfAllowed ? "clawsPage.permissions.yes" : "clawsPage.permissions.no")}
          </dd>
          <dt>${t("clawsPage.permissions.requireAgentId")}</dt>
          <dd>
            ${t(targets.requireAgentId ? "clawsPage.permissions.yes" : "clawsPage.permissions.no")}
          </dd>
        </dl>
      </section>
    </section>
  `;
}

export function renderClawInventory(props: {
  records: ClawStatusEntry[];
  selected: ClawStatusEntry | null;
  doctor: ClawsDoctorResult | null;
  loaded: boolean;
  busy: boolean;
  canUpdate: boolean;
  canRemove: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onUpdate: (record: ClawStatusEntry) => void;
  onRemove: (record: ClawStatusEntry) => void;
}) {
  const record = props.selected;
  return html`
    ${props.loaded && !props.records.length ? html`<p class="muted">${t("clawsPage.empty")}</p>` : nothing}
    <div class="claws-list">
      ${props.records.map(
        (entry) => html` <button
          class="claws-row ${entry.agentId === record?.agentId ? "is-selected" : ""}"
          type="button"
          aria-pressed=${entry.agentId === record?.agentId}
          ?disabled=${props.busy}
          @click=${() => props.onSelect(entry.agentId)}
        >
          <span class="claws-row-icon" aria-hidden="true">${icons.box}</span>
          <span class="claws-row-name"
            ><strong>${entry.name}</strong><span class="muted">${entry.agentId}</span></span
          >
          <span>${entry.version}</span><span class="chip">${entry.status}</span>
        </button>`,
      )}
    </div>
    ${
      record
        ? html` <section class="claws-detail" aria-label=${record.name}>
            <div class="claws-toolbar">
              <h3>${record.name}</h3>
              <button
                class="btn btn--icon"
                aria-label=${t("common.close")}
                title=${t("common.close")}
                @click=${() => props.onSelect("")}
              >
                ${icons.x}
              </button>
            </div>
            <dl class="claws-facts">
              <dt>${t("clawsPage.agent")}</dt>
              <dd>${record.agentId}</dd>
              <dt>${t("clawsPage.version")}</dt>
              <dd>${record.version}</dd>
              <dt>${t("clawsPage.source")}</dt>
              <dd>${record.sourceKind}</dd>
              <dt>${t("clawsPage.status")}</dt>
              <dd>${record.status}</dd>
              <dt>${t("clawsPage.bootstrapState")}</dt>
              <dd>${record.bootstrapState}</dd>
            </dl>
            <div class="claws-actions">
              <button
                class="btn"
                ?disabled=${props.busy || record.agentState === "missing"}
                @click=${() => props.onOpen(record.agentId)}
              >
                ${icons.messageSquare}
                ${t(record.bootstrapState === "complete" ? "clawsPage.openAgent" : "clawsPage.bootstrap")}
              </button>
              <button
                class="btn"
                ?disabled=${props.busy || !props.canUpdate || record.sourceKind !== "package"}
                @click=${() => props.onUpdate(record)}
              >
                ${t("clawsPage.update")}
              </button>
              <button
                class="btn danger"
                ?disabled=${props.busy || !props.canRemove}
                @click=${() => props.onRemove(record)}
              >
                ${icons.trash} ${t("clawsPage.remove")}
              </button>
            </div>
            <h4>${t("clawsPage.resources")}</h4>
            <ul class="claws-resource-list">
              ${record.resources.map(
                (resource) => html`<li>
                  <span
                    ><strong>${resource.id}</strong
                    ><span class="muted"
                      >${resource.kind}${resource.relationship ? ` / ${resource.relationship}` : ""}</span
                    ></span
                  >
                  <span>${resource.state}</span>
                </li>`,
              )}
            </ul>
          </section>`
        : nothing
    }
    ${
      props.doctor?.findings.length
        ? html`<section class="claws-detail">
            <h3>${t("clawsPage.findings")}</h3>
            <ul>
              ${props.doctor.findings.map(
                (finding) => html`<li>
                  <strong>${finding.severity}</strong>: ${finding.message}
                  ${finding.path ? html`<div class="muted">${finding.path}</div>` : nothing}
                  ${finding.fixHint ? html`<p>${finding.fixHint}</p>` : nothing}
                </li>`,
              )}
            </ul>
          </section>`
        : nothing
    }
  `;
}

export function renderClawDialog(props: {
  plan: ClawLifecyclePlanResult | null;
  detail: ClawCatalogDetail | null;
  pending: PendingClawOperation | null;
  intent: "add" | "update" | "remove";
  busy: boolean;
  applying: boolean;
  error: string | null;
  packageName: string;
  version: string;
  agentId: string;
  riskAcknowledged: boolean;
  canApply: boolean;
  applyMethodAvailable: boolean;
  onInput: (field: "packageName" | "version" | "agentId", value: string) => void;
  onRiskChange: (value: boolean) => void;
  onPreview: () => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const plan = props.plan;
  const title = t(
    props.intent === "remove"
      ? "clawsPage.reviewRemove"
      : props.intent === "update"
        ? "clawsPage.reviewUpdate"
        : "clawsPage.reviewAdd",
  );
  const applicable =
    props.canApply &&
    plan &&
    props.pending &&
    buildClawApplyRequest(props.pending, plan, props.riskAcknowledged);
  return html`
    <openclaw-modal-dialog
      label=${title}
      @modal-cancel=${(event: Event) => {
        if (props.applying) {
          event.preventDefault();
        } else {
          props.onClose();
        }
      }}
    >
      <section class="claws-dialog" aria-busy=${props.busy}>
        <header class="claws-toolbar">
          <h2>${title}</h2>
          <button
            class="btn btn--icon"
            ?disabled=${props.applying}
            aria-label=${t("common.close")}
            title=${t("common.close")}
            @click=${props.onClose}
          >
            ${icons.x}
          </button>
        </header>
        ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
        ${
          !plan && props.intent === "add"
            ? html` <form
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  props.onPreview();
                }}
              >
                <label class="field"
                  ><span>${t("clawsPage.packageName")}</span>
                  <input
                    name="packageName"
                    required
                    .value=${props.packageName}
                    ?disabled=${props.busy}
                    @input=${(event: InputEvent) => props.onInput("packageName", (event.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="field"
                  ><span>${t("clawsPage.version")}</span>
                  <input
                    name="version"
                    placeholder=${t("clawsPage.latest")}
                    .value=${props.version}
                    ?disabled=${props.busy}
                    @input=${(event: InputEvent) => props.onInput("version", (event.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="field"
                  ><span>${t("clawsPage.agentId")}</span>
                  <input
                    name="agentId"
                    .value=${props.agentId}
                    ?disabled=${props.busy}
                    @input=${(event: InputEvent) => props.onInput("agentId", (event.target as HTMLInputElement).value)}
                  />
                </label>
                <div class="claws-actions">
                  <button
                    type="submit"
                    class="btn primary"
                    ?disabled=${props.busy || !props.packageName.trim()}
                  >
                    ${t("clawsPage.preview")}
                  </button>
                </div>
              </form>`
            : nothing
        }
        ${props.busy ? html`<p role="status">${t(props.applying ? "clawsPage.applying" : "clawsPage.reviewing")}</p>` : nothing}
        ${
          plan
            ? html`
                <dl class="claws-facts">
                  <dt>${t("clawsPage.name")}</dt>
                  <dd>${plan.target.name ?? props.detail?.packageName ?? ""}</dd>
                  <dt>${t("clawsPage.agent")}</dt>
                  <dd>${plan.target.agentId ?? ""}</dd>
                  ${
                    props.intent !== "remove"
                      ? html`<dt>${t("clawsPage.publisher")}</dt>
                          <dd>${plan.target.publisher ?? t("clawsPage.unknownPublisher")}</dd>`
                      : nothing
                  }
                  <dt>${t("clawsPage.version")}</dt>
                  <dd>
                    ${plan.target.currentVersion ?? ""}${plan.target.currentVersion && plan.target.targetVersion ? " → " : ""}${plan.target.targetVersion ?? ""}
                  </dd>
                </dl>
                <h3>${t("clawsPage.changes")}</h3>
                <ul class="claws-resource-list">
                  ${plan.actions.map(
                    (action) => html`<li>
                      <span
                        ><strong>${action.id}</strong
                        ><span class="muted"
                          >${action.kind}${action.reason ? ` / ${action.reason}` : ""}</span
                        ></span
                      >
                      <span
                        >${action.action}${action.blocked ? ` / ${t("clawsPage.blockers")}` : ""}</span
                      >
                    </li>`,
                  )}
                </ul>
                ${
                  plan.capabilities.length
                    ? html`<h3>${t("clawsPage.capabilities")}</h3>
                        <ul>
                          ${plan.capabilities.map(
                            (capability) =>
                              html`<li>
                                <strong>${capability.id}</strong> (${capability.kind},
                                ${capability.action})
                                <p>${capability.reason}</p>
                              </li>`,
                          )}
                        </ul>`
                    : nothing
                }
                ${
                  plan.effectivePermissions
                    ? html`<section aria-label=${t("clawsPage.permissions.title")}>
                        <h3>${t("clawsPage.permissions.title")}</h3>
                        <p class="muted">${t("clawsPage.permissions.coverage")}</p>
                        ${plan.effectivePermissions.current ? renderConfiguredPermissions(plan.effectivePermissions.current, t("clawsPage.permissions.current")) : nothing}
                        ${plan.effectivePermissions.desired ? renderConfiguredPermissions(plan.effectivePermissions.desired, t(plan.operation === "update" ? "clawsPage.permissions.afterUpdate" : "clawsPage.permissions.afterInstall")) : nothing}
                        ${!plan.effectivePermissions.current && !plan.effectivePermissions.desired ? html`<p>${t("clawsPage.permissions.unavailable")}</p>` : nothing}
                        ${
                          plan.effectivePermissions.unresolved.length
                            ? html`<h4>${t("clawsPage.permissions.unresolvedTitle")}</h4>
                                <ul>
                                  ${plan.effectivePermissions.unresolved.map((category) => html`<li>${t(`clawsPage.permissions.unresolved.${category}`)}</li>`)}
                                </ul>`
                            : nothing
                        }
                      </section>`
                    : nothing
                }
                ${renderScheduledJobs(plan.scheduledJobs)}
                ${
                  plan.readiness?.requirements.length
                    ? html`<h3>${t("clawsPage.readiness")}</h3>
                        <ul>
                          ${plan.readiness.requirements.map((requirement) => html`<li>${requirement.kind}: ${requirement.owner}</li>`)}
                        </ul>`
                    : nothing
                }
                ${
                  plan.blockers.length
                    ? html`<div class="callout danger" role="alert">
                        <h3>${t("clawsPage.blockers")}</h3>
                        <ul>
                          ${plan.blockers.map((blocker) => html`<li>${blocker.message}</li>`)}
                        </ul>
                      </div>`
                    : nothing
                }
                ${plan.trustWarning ? html`<div class="callout warn">${plan.trustWarning}</div>` : nothing}
                ${plan.riskAcknowledgementRequired ? html`<label class="claws-risk"><input type="checkbox" .checked=${props.riskAcknowledged} ?disabled=${props.busy} @change=${(event: Event) => props.onRiskChange((event.target as HTMLInputElement).checked)} /><span>${t("clawsPage.acknowledgeRisk")}</span></label>` : nothing}
                ${!props.canApply ? html`<p role="status">${t(props.applyMethodAvailable ? "clawsPage.adminRequired" : "clawsPage.missingMethod")}</p>` : nothing}
                <div class="claws-actions">
                  <button class="btn" ?disabled=${props.applying} @click=${props.onClose}>
                    ${t("common.cancel")}</button
                  ><button
                    class="btn primary"
                    ?disabled=${props.busy || !applicable}
                    @click=${props.onApply}
                  >
                    ${t("clawsPage.apply")}
                  </button>
                </div>
              `
            : nothing
        }
      </section>
    </openclaw-modal-dialog>
  `;
}
