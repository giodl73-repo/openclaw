import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  ClawCatalogDetail,
  ClawLifecycleApplyResult,
  ClawLifecyclePlanResult,
  ClawStatusEntry,
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";
import {
  validateClawLifecycleApplyResult,
  validateClawLifecyclePlanResult,
  validateClawsCatalogDetailResult,
  validateClawsDoctorResult,
  validateClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/validator-registry-claws.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { newSessionSearch } from "../new-session/location.ts";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { canReadClaws, clawsAvailable } from "./access.ts";
import {
  buildClawApplyRequest,
  clawPlanParams,
  type PendingClawOperation,
} from "./lifecycle-request.ts";
import { renderClawDialog, renderClawInventory } from "./view.ts";
import "./claws.css";

registerPluginManagementEnglish();

export class ClawsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private status: ClawsStatusResult | null = null;
  @state() private doctor: ClawsDoctorResult | null = null;
  @state() private selected: string | null = null;
  @state() private loading = false;
  @state() private busy = false;
  @state() private applying = false;
  @state() private error: string | null = null;
  @state() private readError: string | null = null;
  @state() private unconfirmedOperation = false;
  @state() private completion: ClawLifecycleApplyResult | null = null;
  @state() private dialog = false;
  @state() private intent: "add" | "update" | "remove" = "add";
  @state() private packageName = "";
  @state() private version = "";
  @state() private agentId = "";
  @state() private detail: ClawCatalogDetail | null = null;
  @state() private plan: ClawLifecyclePlanResult | null = null;
  @state() private pending: PendingClawOperation | null = null;
  @state() private riskAcknowledged = false;

  private readGeneration = 0;
  private operationGeneration = 0;
  private lastHello: unknown;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.invalidate(),
    onSnapshot: ({ snapshot }) => {
      // A fresh hello may change operator scopes without replacing the client.
      if (this.lastHello !== snapshot.hello) {
        this.lastHello = snapshot.hello;
        this.gateway.invalidate();
        this.invalidate();
        void this.refresh();
      }
    },
    ensureInitialData: () => void this.refresh(),
  });

  private invalidate() {
    this.unconfirmedOperation ||= this.applying;
    this.readGeneration += 1;
    this.operationGeneration += 1;
    this.status = null;
    this.doctor = null;
    this.selected = null;
    this.loading = false;
    this.busy = false;
    this.applying = false;
    this.completion = null;
    this.closeDialog();
    this.error = null;
    this.readError = null;
  }

  private async refresh() {
    const scope = this.gateway.capture();
    if (!scope || !canReadClaws(this.gateway.snapshot) || this.loading) {
      return;
    }
    const generation = ++this.readGeneration;
    this.readError = null;
    this.doctor = null;
    this.loading = true;
    try {
      const status = await scope.client.request("claws.status", {});
      if (!this.gateway.isCurrent(scope) || generation !== this.readGeneration) {
        return;
      }
      if (!validateClawsStatusResult(status)) {
        throw new Error(t("clawsPage.invalidResponse"));
      }
      // Inventory is authoritative even when the separate diagnostic read fails.
      this.status = status;
      if (!status.records.some((record) => record.agentId === this.selected)) {
        this.selected = null;
      }
      const doctor = await scope.client.request("claws.doctor", {});
      if (!this.gateway.isCurrent(scope) || generation !== this.readGeneration) {
        return;
      }
      if (!validateClawsDoctorResult(doctor)) {
        throw new Error(t("clawsPage.invalidResponse"));
      }
      this.doctor = doctor;
    } catch (error) {
      if (this.gateway.isCurrent(scope) && generation === this.readGeneration) {
        this.readError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && generation === this.readGeneration) {
        this.loading = false;
      }
    }
  }

  private canPlan(operation: PendingClawOperation["operation"]) {
    return canCallGatewayMethod(this.gateway.snapshot, `claws.${operation}.plan`, "operator.read");
  }

  private canApply(operation: PendingClawOperation["operation"]) {
    return canCallGatewayMethod(
      this.gateway.snapshot,
      `claws.${operation}.apply`,
      "operator.admin",
    );
  }

  private async prepare(operation: "add" | "update" | "remove", record?: ClawStatusEntry) {
    const scope = this.gateway.capture();
    if (!scope || this.busy || this.loading || !this.canPlan(operation)) {
      return;
    }
    const generation = ++this.operationGeneration;
    const current = () => this.gateway.isCurrent(scope) && generation === this.operationGeneration;
    this.busy = true;
    this.error = null;
    this.unconfirmedOperation = false;
    this.completion = null;
    this.plan = null;
    this.pending = null;
    this.detail = null;
    this.riskAcknowledged = false;
    this.dialog = true;
    this.intent = operation;
    try {
      let pending: PendingClawOperation;
      if (operation === "remove") {
        if (!record) {
          return;
        }
        pending = { operation, target: record.agentId, removeUnused: false };
      } else {
        if (!canCallGatewayMethod(this.gateway.snapshot, "claws.catalog.detail", "operator.read")) {
          throw new Error(t("clawsPage.missingMethod"));
        }
        const payload = await scope.client.request("claws.catalog.detail", {
          packageName: record?.name ?? this.packageName.trim(),
          ...(operation === "add" && this.version.trim() ? { version: this.version.trim() } : {}),
        });
        if (!current()) {
          return;
        }
        if (!validateClawsCatalogDetailResult(payload)) {
          throw new Error(t("clawsPage.invalidResponse"));
        }
        this.detail = payload.detail;
        const source = { packageName: payload.detail.packageName, version: payload.detail.version };
        pending =
          operation === "update" && record
            ? { operation, target: record.agentId, source }
            : {
                operation: "add",
                source,
                ...(this.agentId.trim() ? { agentId: this.agentId.trim() } : {}),
              };
      }
      const plan = await scope.client.request(`claws.${operation}.plan`, clawPlanParams(pending));
      if (!current()) {
        return;
      }
      if (!validateClawLifecyclePlanResult(plan) || plan.operation !== operation) {
        throw new Error(t("clawsPage.invalidResponse"));
      }
      this.pending = pending;
      this.plan = plan;
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.busy = false;
      }
    }
  }

  private async apply() {
    const scope = this.gateway.capture();
    const pending = this.pending;
    const plan = this.plan;
    if (!scope || !pending || !plan || this.busy || !this.canApply(pending.operation)) {
      return;
    }
    const request = buildClawApplyRequest(pending, plan, this.riskAcknowledged);
    if (!request) {
      return;
    }
    const generation = ++this.operationGeneration;
    const current = () => this.gateway.isCurrent(scope) && generation === this.operationGeneration;
    this.busy = true;
    this.applying = true;
    this.error = null;
    try {
      const result = await scope.client.request(request.method, request.params);
      if (!current()) {
        return;
      }
      if (!validateClawLifecycleApplyResult(result) || result.operation !== pending.operation) {
        throw new Error(t("clawsPage.invalidResponse"));
      }
      this.completion = result;
      this.selected = result.operation === "remove" ? null : result.agentId;
    } catch (error) {
      if (current()) {
        this.unconfirmedOperation = true;
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.applying = false;
        this.busy = false;
        // An interrupted write may have succeeded. Retire its consent and read status;
        // neither a timeout nor reconnect authorizes replaying the apply request.
        this.closeDialog();
        await this.refreshAfterApply(scope);
      }
    }
  }

  private async refreshAfterApply(scope: GatewayConnectionScope) {
    if (this.gateway.isCurrent(scope)) {
      await this.refresh();
    }
  }

  private closeDialog() {
    if (this.applying) {
      return;
    }
    this.operationGeneration += 1;
    this.busy = false;
    this.dialog = false;
    this.plan = null;
    this.pending = null;
    this.detail = null;
    this.riskAcknowledged = false;
  }

  private async openAgent(agentId: string) {
    const scope = this.gateway.capture();
    if (!scope || this.busy) {
      return;
    }
    const context = this.context;
    const agents = context.agents;
    const generation = ++this.operationGeneration;
    const current = () =>
      this.gateway.isCurrent(scope) &&
      this.context === context &&
      this.context.agents === agents &&
      generation === this.operationGeneration;
    this.busy = true;
    this.error = null;
    try {
      const roster = await agents.refreshList();
      if (!current()) {
        return;
      }
      if (
        !roster ||
        !agents.state.connected ||
        agents.state.client !== scope.client ||
        !listSelectableAgents(agents.state.agentsList?.agents ?? []).some(
          (agent) => agent.id === agentId,
        )
      ) {
        throw new Error(t("clawsPage.agentUnavailable", { agent: agentId }));
      }
      context.navigate("new-session", { search: newSessionSearch(agentId) });
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.busy = false;
      }
    }
  }

  override render() {
    const connected = this.gateway.connected;
    const available = clawsAvailable(this.gateway.snapshot);
    const readable = canReadClaws(this.gateway.snapshot);
    const disabled = this.loading || this.busy;
    const error = [
      this.unconfirmedOperation ? t("clawsPage.outcomeUnknown") : null,
      this.error,
      this.readError,
    ]
      .filter(Boolean)
      .join(" ");
    const selected =
      this.status?.records.find((record) => record.agentId === this.selected) ?? null;
    return html`
      ${renderPluginsHubHeader({
        active: "claws",
        gateway: this.gateway.snapshot,
        onSelect: (tab) => this.context.navigate(tab),
      })}
      <wa-tab-panel
        id=${PLUGINS_HUB_PANEL_ID}
        name="claws"
        active
        aria-labelledby="plugins-tab-claws"
      >
        <section class="claws-workspace">
          ${error && !this.dialog ? html`<div class="callout danger" role="alert">${error}</div>` : nothing}
          ${
            !connected || !available || !readable
              ? html`<p role="status">
                  ${t(!connected ? "clawsPage.disconnected" : !available ? "clawsPage.unavailable" : "clawsPage.readRequired")}
                </p>`
              : html`
                  <div class="claws-toolbar">
                    <h2>${t("clawsPage.installed")}</h2>
                    <button
                      class="btn btn--icon"
                      title=${t("common.refresh")}
                      aria-label=${t("common.refresh")}
                      ?disabled=${disabled}
                      @click=${() => void this.refresh()}
                    >
                      ${icons.refresh}
                    </button>
                    <button
                      class="btn primary"
                      ?disabled=${disabled || !this.canPlan("add")}
                      @click=${() => {
                        this.closeDialog();
                        this.intent = "add";
                        this.error = null;
                        this.packageName = "";
                        this.version = "";
                        this.agentId = "";
                        this.dialog = true;
                      }}
                    >
                      ${icons.plus} ${t("clawsPage.add")}
                    </button>
                  </div>
                  ${
                    this.completion
                      ? html`<div class="callout" role="status">
                          <strong
                            >${t(this.completion.status === "complete" ? "clawsPage.complete" : "clawsPage.partial")}</strong
                          >
                          <p>${this.completion.message}</p>
                        </div>`
                      : nothing
                  }
                  ${this.loading ? html`<p role="status">${t("clawsPage.loading")}</p>` : nothing}
                  ${renderClawInventory({
                    records: this.status?.records ?? [],
                    selected,
                    doctor: this.doctor,
                    busy: disabled,
                    loaded: this.status !== null,
                    canUpdate: this.canPlan("update"),
                    canRemove: this.canPlan("remove"),
                    onSelect: (id) => {
                      this.selected = id;
                    },
                    onOpen: (id) => void this.openAgent(id),
                    onUpdate: (record) => void this.prepare("update", record),
                    onRemove: (record) => void this.prepare("remove", record),
                  })}
                `
          }
        </section>
      </wa-tab-panel>
      ${
        this.dialog
          ? renderClawDialog({
              plan: this.plan,
              detail: this.detail,
              pending: this.pending,
              intent: this.intent,
              busy: this.busy,
              applying: this.applying,
              error: error || null,
              packageName: this.packageName,
              version: this.version,
              agentId: this.agentId,
              riskAcknowledged: this.riskAcknowledged,
              canApply: this.pending ? this.canApply(this.pending.operation) : false,
              applyMethodAvailable:
                isGatewayMethodAdvertised(
                  this.gateway.snapshot ?? {},
                  `claws.${this.intent}.apply`,
                ) === true,
              onInput: (field, value) => {
                this[field] = value;
              },
              onRiskChange: (value) => {
                this.riskAcknowledged = value;
              },
              onPreview: () => void this.prepare("add"),
              onApply: () => void this.apply(),
              onClose: () => this.closeDialog(),
            })
          : nothing
      }
    `;
  }
}

if (!customElements.get("openclaw-claws-page")) {
  customElements.define("openclaw-claws-page", ClawsPage);
}
