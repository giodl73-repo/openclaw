// Gateway connection role policy.
// Separates node-role RPCs from operator RPCs before method scope checks.
import { isHostProviderRoleMethod, isNodeRoleMethod } from "./method-scopes.js";

const GATEWAY_ROLES = ["operator", "node", "host-provider"] as const;

/** Gateway connection roles used before method-level operator scope checks. */
export type GatewayRole = (typeof GATEWAY_ROLES)[number];

/** Parses the untrusted role claim from connect params into the closed role set. */
export function parseGatewayRole(roleRaw: unknown): GatewayRole | null {
  if (roleRaw === "operator" || roleRaw === "node" || roleRaw === "host-provider") {
    return roleRaw;
  }
  return null;
}

/** Operators using shared auth may connect before device identity is established. */
export function roleCanSkipDeviceIdentity(role: GatewayRole, sharedAuthOk: boolean): boolean {
  return role === "operator" && sharedAuthOk;
}

/** Keeps node-originated notifications off the operator RPC surface, and vice versa. */
export function isRoleAuthorizedForMethod(role: GatewayRole, method: string): boolean {
  if (isHostProviderRoleMethod(method)) {
    return role === "host-provider";
  }
  if (isNodeRoleMethod(method)) {
    return role === "node";
  }
  return role === "operator";
}
