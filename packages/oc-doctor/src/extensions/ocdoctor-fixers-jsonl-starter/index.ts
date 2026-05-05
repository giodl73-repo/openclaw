/**
 * `ocdoctor-fixers-jsonl-starter` — starter fixer pack for jsonl
 * session logs.
 *
 * Each fixer pairs with a lint rule from
 * `@openclaw/oc-lint/extensions/oclint-rules-jsonl-starter`.
 *
 * @module ocdoctor-fixers-jsonl-starter
 */

import type { OcPathFixerSpec } from '../../plugin-sdk/oc-doctor/types.js';
import { ocPathFixerContribution } from '../../plugin-sdk/oc-doctor/adapter.js';
import { registerDoctorHealthContribution } from '../../plugin-sdk/oc-doctor/registry.js';
import { sessionAppendTerminalEvent } from './fixers/session-append-terminal-event.js';
import { sessionQuarantineMalformedLine } from './fixers/session-quarantine-malformed-line.js';

export const jsonlStarterFixers: readonly OcPathFixerSpec[] = [
  sessionAppendTerminalEvent,
  sessionQuarantineMalformedLine,
];

for (const spec of jsonlStarterFixers) {
  registerDoctorHealthContribution(ocPathFixerContribution(spec));
}

export {
  sessionAppendTerminalEvent,
  sessionQuarantineMalformedLine,
};
