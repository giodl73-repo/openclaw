---
summary: "How plugins and hosts can expose active policy constraints to Control UI settings"
read_when:
  - You are building a plugin or host integration that owns OpenClaw settings
  - You need Control UI to gray out or reject settings blocked by active policy
title: "Settings constraints"
---

# Settings constraints

Settings constraints let a host or bundled plugin describe which config settings are constrained by the active policy. Control UI can use the payload to make blocked controls read-only or narrow their available values, and the gateway uses the same payload to reject conflicting config writes.

The payload is intentionally small:

```json
{
  "version": 1,
  "mode": "active-policy-constraints",
  "settings": {
    "gateway.bind": {
      "path": "gateway.bind",
      "state": "readOnly",
      "reason": "The active policy does not allow gateway binds outside the local host.",
      "source": "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      "policyPath": "gateway.exposure.allowNonLoopbackBind",
      "checkId": "policy/gateway-non-loopback-bind",
      "allowedValues": ["loopback"]
    }
  }
}
```

Use `state: "readOnly"` when the setting must not change away from an allowed value. Use `state: "enabled"` when the control can remain editable but must stay inside `allowedValues` or outside `deniedValues`. Include `reason` because it is the text Control UI and config write errors can show to explain why the setting is constrained.

The bundled Policy plugin registers a settings constraints provider with `registerSettingsConstraintsProvider`. Its worked example lives in `extensions/policy/examples/hosted-control-ui-lockdown.policy.jsonc`, with the expected Control UI payload in `extensions/policy/examples/hosted-control-ui-lockdown.constraints.json`. The Policy plugin tests read both files so the example stays aligned with the runtime projection.

Hosts that do not use this contract do not opt into any visible behavior. When no provider returns constraints, Control UI receives no `policySettingsConstraints` bootstrap field and config writes follow the normal path.
