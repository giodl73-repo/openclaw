/**
 * Fixer: `jsonc-starter-v0/config/redact-secret-literal`
 * Pairs with: `jsonc-starter-v0/config/secret-as-literal` (lint warning)
 *
 * Replaces token-shaped string literals with `${ENV_VAR_PLACEHOLDER}`
 * references. **Destructive in spirit but additive in effect**: the
 * original literal is replaced (not deleted), and the operator must
 * supply the actual env-var name.
 *
 * **Idempotency**: re-running on a file where all token literals have
 * already been replaced is a no-op (no detect findings, no rewrite).
 *
 * **Diagnostic safety**: the diagnostic message NEVER includes secret
 * bytes — only a shape fingerprint (token-class label + length).
 * 8-char prefix leaks via `s.slice(0, 8)` are forbidden.
 */
import { emitJsonc, parseOcPath, setOcPath } from '@openclaw/oc-path';
import type { JsoncValue, OcPath, OcPathMatch } from '@openclaw/oc-path';
import { STARTER_TOKEN_PATTERNS } from '@openclaw/oc-lint';
import type { TokenPattern } from '@openclaw/oc-lint';
import type { DoctorDetectResult, OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

function classifySecret(s: string): TokenPattern | null {
  return STARTER_TOKEN_PATTERNS.find((p) => p.re.test(s)) ?? null;
}

/**
 * Shape-only fingerprint for diagnostic messages. Never echoes the
 * secret. Format: `<token-class>:<length>` (e.g. `github-personal-token:48`).
 */
function fingerprint(s: string, pattern: TokenPattern): string {
  return `${pattern.label}:${s.length}`;
}

interface SecretHit {
  readonly path: OcPath;
  readonly value: string;
  readonly pattern: TokenPattern;
  readonly line: number;
}

function findSecretLeaves(
  node: JsoncValue,
  fileName: string,
  segments: readonly string[],
  out: SecretHit[],
): void {
  if (node.kind === 'string') {
    const pattern = classifySecret(node.value);
    if (pattern !== null) {
      out.push({
        path: makePath(fileName, segments),
        value: node.value,
        pattern,
        line: node.line ?? 1,
      });
    }
    return;
  }
  if (node.kind === 'object') {
    for (const e of node.entries) {
      findSecretLeaves(e.value, fileName, [...segments, e.key], out);
    }
    return;
  }
  if (node.kind === 'array') {
    node.items.forEach((v, i) => {
      findSecretLeaves(v, fileName, [...segments, String(i)], out);
    });
  }
}

function makePath(fileName: string, segments: readonly string[]): OcPath {
  // Pack up to 3 sub-segments into section/item/field; deeper paths
  // collapse the tail into dotted form on the field slot.
  if (segments.length === 0) return parseOcPath(`oc://${fileName}`);
  if (segments.length === 1) return parseOcPath(`oc://${fileName}/${segments[0]}`);
  if (segments.length === 2) return parseOcPath(`oc://${fileName}/${segments[0]}/${segments[1]}`);
  if (segments.length === 3) return parseOcPath(`oc://${fileName}/${segments[0]}/${segments[1]}/${segments[2]}`);
  // 4+ segments: section/item/field-with-dotted-overflow.
  return parseOcPath(`oc://${fileName}/${segments[0]}/${segments[1]}/${segments.slice(2).join('.')}`);
}

export const configRedactSecretLiteral: OcPathFixerSpec = {
  id: 'jsonc-starter-v0/config/redact-secret-literal',
  description:
    'Replace token-shaped string literals with ${ENV_VAR_PLACEHOLDER} references',
  // Pairs with `jsonc-starter-v0/config/secret-as-literal` (error).
  // Fixer severity matches the rule — a leaked secret in config is
  // irreversible once committed to git history, so fail-closed at
  // detect is the right default.
  severity: 'error',
  appliesTo: '*.jsonc',

  detect({ ast, fileName }): readonly DoctorDetectResult[] {
    if (ast.kind !== 'jsonc') return [];
    if (ast.root === null) return [];
    const hits: SecretHit[] = [];
    findSecretLeaves(ast.root, fileName, [], hits);
    return hits.map((hit): DoctorDetectResult => {
      const ocPathMatch: OcPathMatch = {
        path: hit.path,
        match: {
          kind: 'leaf',
          valueText: hit.value,
          leafType: 'string',
          line: hit.line,
        },
      };
      return {
        match: ocPathMatch,
        message: `${fileName}: literal secret \`${fingerprint(hit.value, hit.pattern)}\` found in config — rotate and replace with \${ENV_VAR}`,
        fixHint: 'replace literal with `${ENV_VAR}`; rotate the leaked secret',
      };
    });
  },

  fix({ ast, raw, match }) {
    if (ast.kind !== 'jsonc') return raw;
    if (match.match.kind !== 'leaf') return raw;
    // Route through substrate `setOcPath` — writes the placeholder at
    // exactly the leaf addressed by `match.path`. No more split/join on
    // raw bytes (which clobbered any matching substring including
    // comments and keys). The detect/fix fan-out semantic means each
    // secret gets its own `fix()` call; the runner re-detects and
    // re-fixes until no findings remain.
    const placeholder = '${ENV_VAR_PLACEHOLDER}';
    const result = setOcPath(ast, match.path, placeholder);
    if (!result.ok) return raw;
    if (result.ast.kind !== 'jsonc') return raw;
    return emitJsonc(result.ast);
  },
};
