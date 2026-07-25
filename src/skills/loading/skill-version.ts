// Skill prompt versions are deterministic content markers for model-visible skill catalogs.
import { sha256Hex, sha256HexPrefix } from "../../infra/crypto-digest.js";

export function computeSkillPromptVersion(content: string): string {
  return `sha256:${sha256HexPrefix(content, 16)}`;
}

export function computeSkillContentDigest(content: string): string {
  return `sha256:${sha256Hex(content)}`;
}
