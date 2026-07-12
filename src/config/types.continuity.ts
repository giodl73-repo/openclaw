/** Runtime state continuity guarantee selected by the operator. */
export type ContinuityLevel = "conventional" | "archived" | "portable" | "elastic";

/** Additive continuity configuration. Omission preserves Conventional behavior. */
export type ContinuityConfig = {
  /** Minimum complete continuity guarantee requested for this runtime. */
  level?: ContinuityLevel;
};
