---
summary: "Add or update product-owned text without breaking locale fallback, automation output, or generated catalogs"
read_when:
  - Adding or changing user-visible text
  - Adding a locale or translation
  - Updating UI, CLI, native-app, plugin, or documentation catalogs
title: "Localization contributor guide"
---

# Localize product-owned text

Use this workflow when you add or change text that OpenClaw presents to users
or operators. Start from reviewed English, localize at the final rendering
boundary, and keep operational data unchanged.

Do not use this workflow for logs, developer-only diagnostics, model-generated
content, upstream error details, protocol codes, commands, flags, paths, IDs,
versions, provider names, or user-authored data.

## Before you begin

- Identify the owner of the rendering surface.
- Check `localization/coverage.json` for the surface's source catalog, generated
  artifacts, locale maturity, and required checks.
- Preserve an existing structured mode such as `--json`. Localization must not
  change field names, status or reason codes, stable arrays, or value semantics.
- Obtain the owning maintainer's approval before changing Gateway, channel
  safety, plugin SDK, command metadata, or skill metadata contracts.

## Choose the owning workflow

| Surface                          | English source                                                      | Update workflow                                                                     | Validation                                                                       |
| -------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Control UI                       | `ui/src/i18n/locales/en.ts`                                         | `pnpm ui:i18n:sync`                                                                 | `pnpm ui:i18n:verify`                                                            |
| CLI runtime                      | `src/cli/i18n/locales/en.ts`                                        | Edit the owning typed catalog and locale catalogs                                   | Focused renderer tests and `pnpm localization:coverage:sync`                     |
| CLI onboarding and channel setup | `src/wizard/i18n/locales/en.ts`                                     | Edit the wizard catalogs                                                            | `pnpm exec vitest run src/wizard/i18n/index.test.ts`                             |
| Android and Apple apps           | `apps/.i18n/native-source.json` generated from native source        | `pnpm native:i18n:sync`, then the generated locale refresh workflow described below | `pnpm native:i18n:check`, `pnpm android:i18n:check`, and `pnpm apple:i18n:check` |
| Documentation                    | English pages under `docs/` and `docs/.i18n/glossary.<locale>.json` | Publish-repo translation workflow                                                   | `pnpm docs:check-i18n-glossary`                                                  |

Do not hand-edit generated native catalogs, translated documentation trees, or
translation-memory files. Use the owning generator so source hashes and
catalog revisions remain current.

Native source changes first update `apps/.i18n/native-source.json` with
`pnpm native:i18n:sync`. After the source change lands,
`.github/workflows/native-app-locale-refresh.yml` refreshes every registered
locale artifact, regenerates Android resources and Apple string catalogs, runs
all three native checks, and opens or updates the generated-artifact pull
request. Maintainers reproducing that workflow locally need translation
provider credentials and must run, in order:

```bash
pnpm native:i18n:sync
node --import tsx scripts/native-app-i18n.ts sync --write --locale <code>
node --import tsx scripts/android-app-i18n.ts sync
node --import tsx scripts/apple-app-i18n.ts sync-ios --write
pnpm native:i18n:check
pnpm android:i18n:check
pnpm apple:i18n:check
```

Repeat the locale-refresh command for every affected locale. A source pull
request is not expected to hand-author generated translations or projections.

## Add a string

1. **Classify the text.** Confirm that it is product-owned presentation rather
   than a log, opaque upstream diagnostic, or operational value.
2. **Localize at the edge.** Pass structured data to the final CLI, UI, TUI,
   channel, or native renderer. Do not translate deep exception construction or
   business logic.
3. **Add or reuse a stable key.** Add a namespaced semantic key for a new
   message. Reuse the existing key for a copy-only change. Describe meaning
   rather than English wording, for example
   `cli.update.completion.refreshFailed`.
4. **Classify parameters.**
   - Keep commands, flags, paths, IDs, PIDs, versions, codes, raw errors, and
     user data literal.
   - Give product-owned modes, phases, statuses, and other presentation enums
     catalog-backed labels or `select` cases.
5. **Update reviewed English.** Existing English output remains compatible
   unless the change intentionally includes an English-copy change.
6. **Update translations through the owning workflow.** Affected complete
   locale rows become partial until the generated translation and required
   review are present; report stale translations as findings, not maturity
   states.
7. **Add rendering proof.** Cover reviewed English, at least one non-English
   locale, unsupported-locale fallback, placeholders, and protected literals.
   When the surface has structured output, compare English and non-English
   payloads for exact equality.
8. **Refresh generated state.** Run the surface generator and
   `pnpm localization:coverage:sync`.
9. **Run the repository baseline and owning-surface checks.**

```bash
pnpm localization:check
```

Then run the matching validation command from the workflow table. The aggregate
command covers shared catalogs, coverage, CLI and wizard tooling, native source
and translation artifacts, and Android and Apple projections. It does not
replace owner-specific Control UI verification, documentation glossary checks,
or focused renderer tests.

The aggregate command prints only the native-app advisory count. Run
`pnpm native:i18n:check` when you need each native translation-quality finding.

Commit source changes and generated artifacts together. Do not mark a
locale/surface combination complete while it still relies on untranslated
fallback or stale source text.

## Review simpler-script backfill

PR 14 tracks the registered left-to-right locales that do not require the
dedicated Indic, Thai, or Arabic-derived-script proof reserved for PR 15:
`zh-CN`, `zh-TW`, `pt-BR`, `de`, `es`, `ja-JP`, `ko`, `fr`, `it`, `tr`, `uk`,
`id`, `pl`, `vi`, `nl`, `ru`, and `sv`.

Run:

```bash
pnpm localization:backfill:check
```

The checked report at `localization/simple-script-backfill.json` records
remaining artifact, fallback, native-quality, and human-review blockers for
each locale. Zero fallback is necessary but not sufficient for promotion:
generated or model-assisted copy remains partial until a named language owner
records the required linguistic and sensitive-copy review in
`localization/simple-script-reviews.json`. Change a locale to `reviewed` only
after that review is complete and include the accountable `languageOwner`.

## Change an existing string

Treat an English source edit as a new translation revision:

1. update the English source and any glossary entries;
2. regenerate the owning catalogs or translation artifacts;
3. review placeholder and protected-literal changes;
4. update snapshots only when the English change is intentional;
5. refresh `localization/coverage.json`;
6. demote affected complete locale rows to partial until the new source
   revision is translated and reviewed, and report stale translations
   separately.

Keeping the same key does not make an older translation current.

## Add a locale

1. Add the canonical BCP 47 identifier, aliases, fallback, and direction to
   `packages/localization-core/src/locale-registry.ts`.
2. Add resolution tests for canonical IDs, aliases, unsupported inputs, and
   fallback behavior.
3. Add the locale to each owning generator that supports the surface.
4. Add representative shaping, segmentation, expansion, and bidirectional
   fixtures when the script requires them.
5. Regenerate `localization/coverage.json`.
6. Start every surface as `partial`, `experimental`,
   `platform-constrained`, or `unsupported`. Promote it to `complete` only
   after all required checks and reviews pass.

Locale registration means OpenClaw recognizes the locale. It does not claim
that every product surface is translated.

## Troubleshoot localization checks

### Coverage manifest is stale

Run:

```bash
pnpm localization:coverage:sync
```

Commit `localization/coverage.json` with the catalog or registry change.

### Placeholder validation fails

Use the same placeholder names in every translated branch. Do not translate
placeholder names or replace a literal parameter with translated prose.

### A generated catalog changed unexpectedly

Stop and confirm that you ran the generator for the owning surface. Do not
manually repair generated output. Revert unrelated generated changes and rerun
the narrow workflow.

### A translated message contains English fragments

Check whether a raw internal enum or English presentation label was passed as a
parameter. Move product-owned labels into the catalog. Preserve only genuine
operational literals.

## See also

- [Testing](/reference/test)
- [CLI reference](/cli/index)
- [Control UI](/web/control-ui)
- [Plugin manifest](/plugins/manifest)
