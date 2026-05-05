/**
 * Test scaffolding for constructing DoctorFile objects with the
 * right AST given the file extension.
 */
import {
  inferKind,
  parseJsonc,
  parseJsonl,
  parseMd,
  type OcAst,
} from '@openclaw/oc-path';
import type { DoctorFile } from '../src/plugin-sdk/oc-doctor/types.js';

export function makeDoctorFile(name: string, path: string, raw: string): DoctorFile {
  const kind = inferKind(name);
  let ast: OcAst;
  if (kind === 'jsonc') ast = parseJsonc(raw).ast;
  else if (kind === 'jsonl') ast = parseJsonl(raw).ast;
  else ast = parseMd(raw).ast; // default to md
  return { name, path, raw, ast };
}
