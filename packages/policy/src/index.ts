/**
 * `@openclaw/policy` — claws-hapi prototype of the upstream
 * `policy-anchoring` PR-1 surface (PolicyIR types contract +
 * reference markdown extractor pack).
 *
 * Strategic frame: policy is a generated artifact — the gateway
 * compiles validated workspace content into a stable shape that any
 * conforming guardrail can evaluate. Upstream lands the **types
 * contract** only; downstream packages (this one, plus future
 * OPA/CEL/yaml shims) ship their own `PolicyGenerator<TValidated>`
 * impl.
 *
 * Consumes oc-path's universal verbs (`resolveOcPath`,
 * `findOcPaths`) and workspace manifest. Sister to
 * `oc-path` / `oc-paths-lint` / `oc-doctor` /
 * `lkg` — the third consumer of the universal
 * substrate, parallel to lint and doctor.
 *
 * @module @openclaw/policy
 */

export * from './plugin-sdk/policy/index.js';
