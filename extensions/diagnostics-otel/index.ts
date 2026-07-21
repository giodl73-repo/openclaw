// Diagnostics Otel plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDiagnosticsOtelExporter } from "./runtime-api.js";

export default definePluginEntry({
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  register(api) {
    const exporter = createDiagnosticsOtelExporter();
    api.registerService(exporter.service);
    api.on("subagent_ended", exporter.recordSubagentEnded);
  },
});
