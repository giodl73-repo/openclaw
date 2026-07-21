// Diagnostics Otel runtime API exposes service factories to trusted runtime callers.
export { createDiagnosticsOtelExporter, createDiagnosticsOtelService } from "./src/service.js";
export type { OpenClawPluginServiceContext } from "./api.js";
