import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");

export const TUI_LOCALIZATION_GUARD_FILES = [
  "src/tui/tui-status-summary.ts",
  "src/tui/tui-command-handlers.ts",
  "src/tui/tui-session-actions.ts",
  "src/tui/tui-event-handlers.ts",
  "src/tui/tui-local-shell.ts",
  "src/tui/tui-plugin-approvals.ts",
  "src/tui/tui-task-suggestions.ts",
  "src/tui/tui-busy-notice.ts",
  "src/tui/tui-submit-state.ts",
  "src/tui/components/searchable-select-list.ts",
  "src/tui/components/filterable-select-list.ts",
] as const;

export const FORBIDDEN_TUI_COPY = [
  "Gateway status",
  "Link channel: unknown",
  "System:",
  "Heartbeat:",
  "Session store:",
  "Default model:",
  "Active sessions:",
  "Recent sessions:",
  "Queued system events",
  "loading models...",
  "no models available",
  "model set to",
  "model list failed",
  "no agents found",
  "Short context breakdown",
  "Machine-readable context report",
  "Tool output",
  "Show thinking",
  "session change in progress",
  "auth login is only available",
  "opening auth flow",
  "auth flow finished",
  "auth flow failed",
  "status: unknown response",
  "Usage: /btw",
  "returning to OpenClaw",
  "usage: /think",
  "usage: /verbose",
  "usage: /trace",
  "usage: /fast",
  "usage: /reasoning",
  "usage: /usage",
  "usage: /elevated",
  "usage: /activation",
  "abort the current run before",
  "new session failed",
  "sessions.create returned no session key",
  "agent is busy",
  "message not sent",
  "agents list failed",
  "sessions list failed",
  "runtime prewarm failed",
  "history failed",
  "agent is finishing context",
  "no active run",
  "abort failed",
  "This response is taking longer than expected",
  "auth or provider access failed",
  "run error:",
  "run aborted",
  "Allow local shell commands",
  "This runs commands on YOUR machine",
  "Select Yes/No",
  "local shell: enabled",
  "local shell: not enabled",
  "local shell: cancelled",
  "working directory was deleted",
  "search: ",
  "Filter: ",
  "No matches",
  "Severity:",
  "Approve this change",
  "Always allow",
  "Do not apply this change",
  "workspace skill approval",
  "plugin approval",
  "request remains pending",
  "Suggested follow-up:",
  "Start in worktree",
  "Create an isolated session",
  "Leave the repository untouched",
  "Instructions:",
  "PgUp/PgDn to inspect",
  "follow-up task",
] as const;

export type TuiHardcodedCopyFinding = {
  file: string;
  line: number;
  literal: string;
  phrase: string;
};

const ALLOWED_STABLE_TOKENS = new Set(["abort failed"]);

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  ) {
    return (node as ts.TemplateLiteralLikeNode).text;
  }
  return null;
}

export function findHardcodedTuiCopy(
  sourceText: string,
  file = "source.ts",
): TuiHardcodedCopyFinding[] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: TuiHardcodedCopyFinding[] = [];
  const visit = (node: ts.Node) => {
    const text = literalText(node);
    if (text !== null && !ALLOWED_STABLE_TOKENS.has(text)) {
      for (const phrase of FORBIDDEN_TUI_COPY) {
        if (!text.includes(phrase)) {
          continue;
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({ file, line: line + 1, literal: text, phrase });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export function checkTuiLocalizationGuard(root = ROOT): TuiHardcodedCopyFinding[] {
  return TUI_LOCALIZATION_GUARD_FILES.flatMap((relativePath) => {
    const fullPath = path.join(root, relativePath);
    return findHardcodedTuiCopy(fs.readFileSync(fullPath, "utf8"), relativePath);
  });
}

function main(): void {
  const findings = checkTuiLocalizationGuard();
  if (findings.length === 0) {
    process.stdout.write(
      `TUI localization guard passed (${TUI_LOCALIZATION_GUARD_FILES.length} files).\n`,
    );
    return;
  }
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}: hardcoded TUI copy "${finding.phrase}"\n`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main();
}
