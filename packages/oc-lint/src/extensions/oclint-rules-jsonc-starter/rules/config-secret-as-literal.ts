/**
 * Rule: `jsonc-starter-v0/config/secret-as-literal`
 * Severity: error
 * Applies to: *.jsonc
 *
 * Flag: any string value matching common token shapes (GitHub PAT,
 * generic 40+ char hex, AWS-style accesskey-prefix). Secrets-as-literals
 * in config tracked by LKG-git would write tokens to git history; the
 * rule surfaces this so operators can replace with `${ENV_VAR}` references.
 *
 * Walks every leaf string under the AST. **Severity is error** (was
 * warning at landing): a secret in config is irreversible once
 * committed to git history, so failing CI is the right default. Token
 * shapes are conservative — false positives are rare enough that the
 * cost of `# lint:disable` for an exception is acceptable.
 */
import type {
  LintRule,
  LintFinding,
} from '../../../plugin-sdk/oc-lint/types.js';
import { STARTER_TOKEN_PATTERNS } from '../../../shared/starter-values.js';
import type { JsoncValue } from '@openclaw/oc-path';

/**
 * Reject placeholder-shape strings before checking secret regexes.
 * Real secrets have entropy — runs of identical characters or short
 * repeating patterns are placeholders ("0000…0000" zero-hash, "ffff…ffff"
 * sentinel, "deadbeefdeadbeef" debug pattern). The hex-secret regex
 * `/^[a-fA-F0-9]{40,}$/` matches all of these as false positives.
 */
function isPlaceholderHex(s: string): boolean {
  if (s.length < 8) return false;
  // Single repeated character: "0000…", "ffff…"
  if (/^(.)\1+$/.test(s)) return true;
  // Repeated short pattern: "deadbeefdeadbeef…", "abababab…"
  for (const len of [2, 4, 8]) {
    if (s.length % len === 0 && s.length / len >= 4) {
      const head = s.slice(0, len);
      let allSame = true;
      for (let i = len; i < s.length; i += len) {
        if (s.slice(i, i + len) !== head) { allSame = false; break; }
      }
      if (allSame) return true;
    }
  }
  return false;
}

function looksLikeSecret(s: string): boolean {
  if (isPlaceholderHex(s)) return false;
  return STARTER_TOKEN_PATTERNS.some((p) => p.re.test(s));
}

function walkLeaves(
  value: JsoncValue,
  ocPath: string,
  fileName: string,
  out: LintFinding[],
): void {
  if (value.kind === 'string') {
    if (looksLikeSecret(value.value)) {
      out.push({
        message: `${fileName}: value looks like a literal secret/token`,
        ocPath,
        line: value.line ?? 1,
        fixHint: 'replace with `${ENV_VAR}` reference; rotate the leaked secret',
      });
    }
    return;
  }
  if (value.kind === 'object') {
    for (const e of value.entries) {
      walkLeaves(e.value, `${ocPath}.${e.key}`, fileName, out);
    }
    return;
  }
  if (value.kind === 'array') {
    value.items.forEach((v, i) => {
      walkLeaves(v, `${ocPath}.${i}`, fileName, out);
    });
  }
}

export const configSecretAsLiteral: LintRule = {
  id: 'jsonc-starter-v0/config/secret-as-literal',
  severity: 'error',
  description: 'config string values matching common secret/token shapes',
  appliesTo: '*.jsonc',
  check(ctx) {
    if (ctx.ast.kind !== 'jsonc') return [];
    const out: LintFinding[] = [];
    if (ctx.ast.root !== null) {
      walkLeaves(ctx.ast.root, `oc://${ctx.fileName}`, ctx.fileName, out);
    }
    return out;
  },
};
