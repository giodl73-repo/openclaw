import fs from "node:fs/promises";
import os from "node:os";
import { scrubConfigAuditLog } from "../config/io.audit.js";
import { note } from "../terminal/note.js";

const NOTE_TITLE = "Config audit";

function formatEntryCount(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

type ConfigAuditScrubDeps = {
  scrubConfigAuditLog?: typeof scrubConfigAuditLog;
};

export type ConfigAuditScrubFinding = {
  rewritten: number;
  message: string;
  fixHint: string;
};

function createScrubFs() {
  return { promises: fs };
}

export async function detectConfigAuditScrubFindings(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  doctorFixCommand?: string;
  deps?: ConfigAuditScrubDeps;
}): Promise<readonly ConfigAuditScrubFinding[]> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const scrub = params.deps?.scrubConfigAuditLog ?? scrubConfigAuditLog;
  const preview = await scrub({
    fs: createScrubFs(),
    env,
    homedir,
    dryRun: true,
  });
  if (preview.rewritten === 0) {
    return [];
  }
  const fixCommand = params.doctorFixCommand ?? "openclaw doctor --fix";
  return [
    {
      rewritten: preview.rewritten,
      message: `${formatEntryCount(preview.rewritten)} in config-audit.jsonl still contain pre-redactor argv values (likely plaintext credentials at rest).`,
      fixHint: `Run \`${fixCommand}\` to rewrite the argv/execArgv fields through the same redactor used for new entries.`,
    },
  ];
}

export async function repairConfigAuditScrubFindings(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  deps?: ConfigAuditScrubDeps;
}): Promise<{
  status?: "repaired" | "skipped" | "failed";
  changes: string[];
  warnings: string[];
}> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const scrub = params.deps?.scrubConfigAuditLog ?? scrubConfigAuditLog;
  const result = await scrub({
    fs: createScrubFs(),
    env,
    homedir,
  });
  if (result.aborted) {
    return {
      status: "failed",
      changes: [],
      warnings: [
        "Config audit scrub was aborted because new entries were appended to config-audit.jsonl during the rewrite. No records were modified. Stop the gateway (or wait until it is idle) and rerun `openclaw doctor --fix`.",
      ],
    };
  }
  if (result.rewritten === 0) {
    return { status: "repaired", changes: [], warnings: [] };
  }
  return {
    status: "repaired",
    changes: [
      `Scrubbed ${formatEntryCount(result.rewritten)} in config-audit.jsonl that still contained pre-redactor argv values. Rotate any credentials that may have been written to the log before the forward redactor shipped.`,
    ],
    warnings: [],
  };
}

export async function maybeScrubConfigAuditLog(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  doctorFixCommand?: string;
}): Promise<void> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;

  try {
    if (params.shouldRepair) {
      const result = await repairConfigAuditScrubFindings({ env, homedir });
      const messages = [...result.changes, ...result.warnings];
      if (messages.length > 0) {
        note(messages.join("\n"), NOTE_TITLE);
      }
      return;
    }

    const findings = await detectConfigAuditScrubFindings({
      env,
      homedir,
      doctorFixCommand: params.doctorFixCommand,
    });
    if (findings.length > 0) {
      note(
        findings.map((finding) => `${finding.message} ${finding.fixHint}`).join("\n"),
        NOTE_TITLE,
      );
    }
  } catch (err) {
    note(
      `Config audit scrub failed: ${err instanceof Error ? err.message : String(err)}`,
      NOTE_TITLE,
    );
  }
}
