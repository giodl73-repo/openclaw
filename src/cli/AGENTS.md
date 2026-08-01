# CLI Localization Guide

CLI localization owns human presentation at the command boundary. Preserve
machine-readable output and operational values exactly.

## Shared CLI catalog ownership

- `i18n/locales/` is the `cli-shell` catalog authority shared by adopted CLI
  command families. Command owners retain message semantics and tests; do not
  create command-local translators or catalog roots.
- Resolve one immutable localization context at the command action boundary
  and pass it to shared validation/rendering helpers. Do not read the process
  locale inside individual message helpers.

## ACP and capability guidance

- Localize only OpenClaw-owned validation and wrapper text. Keep provenance
  values, capability IDs, commands, flags, and upstream error details literal.
- Structured capability output is locale-invariant; localization applies only
  to the final human error boundary.

## Agent command guidance

- Resolve one CLI localization context before message-file parsing and reuse it
  through pre-dispatch validation. Keep agent/session IDs, paths, URLs, command
  tokens, model/provider output, and Gateway diagnostics literal.
- Do not translate transport errors or infer a retry policy from localized
  prose. Structured Gateway outcomes and JSON remain locale-invariant.

## Updater dry-run ownership

- Author reviewed English in `i18n/locales/en.ts` and keep the hand-owned
  bootstrap targets aligned until a later updater-owner slice adopts generated
  output.
- Resolve one immutable localization context at the updater dry-run
  presentation boundary and reuse it for that render.
- Localize labels and surrounding prose only. Keep package channels, versions,
  paths, commands, flags, action IDs, reason codes, and raw errors literal.
- Preserve `--json` payloads exactly across locales. Do not reuse localized
  display labels as structured values.
- Keep reviewed English as the deterministic unsupported-locale and failure
  fallback.

## Adoption and verification

- Register the shared CLI catalog source in `localization/surfaces.json` and update
  `.agents/skills/localize-openclaw/SKILL.md` when another command family is adopted.
- Extend the shared `localization/catalogs.json` gate and refresh workflow when
  moving a family to generated catalogs; do not create a CLI-specific pipeline.
- Run `node scripts/run-vitest.mjs src/cli/i18n/runtime.test.ts
src/cli/update-cli.test.ts` for updater localization changes.
- Test reviewed English, a supported non-English locale, unsupported-locale
  fallback, literal preservation, and exact structured-output equality.
