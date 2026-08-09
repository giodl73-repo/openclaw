export const HOSTING_PROFILE_IDS = ["local", "container", "reverse-proxy", "node-mode"] as const;

export type HostingProfileId = (typeof HOSTING_PROFILE_IDS)[number];
