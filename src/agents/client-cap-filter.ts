import type { AnyAgentTool } from "./tools/common.js";

/** Drops tools that the originating gateway client cannot render. */
export function filterToolsByClientCaps(
  tools: AnyAgentTool[],
  declaredClientCaps: string[] | undefined,
): AnyAgentTool[] {
  const clientCaps = new Set(declaredClientCaps ?? []);
  return tools.filter(
    (tool) => !tool.requiredClientCaps?.some((requiredCap) => !clientCaps.has(requiredCap)),
  );
}
