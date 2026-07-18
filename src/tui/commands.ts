// Defines TUI slash commands and their help metadata.
import type { SlashCommand } from "@earendil-works/pi-tui";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { CommandEntry } from "../../packages/gateway-protocol/src/index.js";
import {
  listChatCommands,
  listChatCommandsForConfig,
  resolveTextCommand,
} from "../auto-reply/commands-registry.js";
import { formatThinkingLevels, listThinkingLevelLabels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.js";
import { TUI_ENGLISH_LOCALIZATION, type TuiLocalization } from "./i18n/runtime.js";

const VERBOSE_LEVELS = ["on", "off"];
const TRACE_LEVELS = ["on", "off"];
const FAST_LEVELS = ["status", "auto", "on", "off"];
const REASONING_LEVELS = ["on", "off"];
const ELEVATED_LEVELS = ["on", "off", "ask", "full"];
const ACTIVATION_LEVELS = ["mention", "always"];
const USAGE_FOOTER_LEVELS = ["off", "tokens", "full", "reset", "inherit", "clear", "default"];

type ParsedCommand = {
  name: string;
  args: string;
};

type SlashCommandOptions = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevels?: Array<{ id: string; label: string }>;
  local?: boolean;
  dynamicCommands?: CommandEntry[];
  localization?: TuiLocalization;
};

const COMMAND_ALIASES: Record<string, string> = {
  crestodian: "openclaw", // hidden alias
  gwstatus: "gateway-status",
};

// These shared commands have explicit local TUI routing but no same-named
// built-in autocomplete entry. Other shared commands require the Gateway and
// must stay out of local autocomplete and model prompts.
const LOCAL_TUI_ROUTED_SHARED_COMMANDS = new Set(["btw", "goal", "stop"]);

function createLevelCompletion(
  levels: string[],
): NonNullable<SlashCommand["getArgumentCompletions"]> {
  return (prefix) =>
    levels
      .filter((value) => value.startsWith(normalizeLowercaseStringOrEmpty(prefix)))
      .map((value) => ({
        value,
        label: value,
      }));
}

function normalizeSlashCommandName(value: string): string {
  return value.replace(/^\//, "").trim();
}

function appendSlashCommand(
  commands: SlashCommand[],
  seen: Set<string>,
  name: string,
  description: string,
) {
  const normalizedName = normalizeSlashCommandName(name);
  if (!normalizedName || seen.has(normalizedName)) {
    return;
  }
  seen.add(normalizedName);
  commands.push({ name: normalizedName, description });
}

export function parseCommand(input: string): ParsedCommand {
  const sharedCommand = resolveTextCommand(input);
  if (sharedCommand) {
    return {
      name: sharedCommand.command.key,
      args: sharedCommand.args ?? "",
    };
  }
  const trimmed = input.replace(/^\//, "").trim();
  if (!trimmed) {
    return { name: "", args: "" };
  }
  const [name, ...rest] = trimmed.split(/\s+/);
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return {
    name: COMMAND_ALIASES[normalized] ?? normalized,
    args: rest.join(" ").trim(),
  };
}

/** Whether a slash input belongs to the shared Gateway command registry. */
export function isSharedTextCommand(input: string): boolean {
  return resolveTextCommand(input) !== null;
}

export function getSlashCommands(options: SlashCommandOptions = {}): SlashCommand[] {
  const localization = options.localization ?? TUI_ENGLISH_LOCALIZATION;
  const t = localization.t;
  const thinkLevels = options.thinkingLevels?.length
    ? options.thinkingLevels.map((level) => level.label)
    : listThinkingLevelLabels(options.provider, options.model, undefined, options.agentRuntime);
  const verboseCompletions = createLevelCompletion(VERBOSE_LEVELS);
  const traceCompletions = createLevelCompletion(TRACE_LEVELS);
  const fastCompletions = createLevelCompletion(FAST_LEVELS);
  const reasoningCompletions = createLevelCompletion(REASONING_LEVELS);
  const usageCompletions = createLevelCompletion(USAGE_FOOTER_LEVELS);
  const elevatedCompletions = createLevelCompletion(ELEVATED_LEVELS);
  const activationCompletions = createLevelCompletion(ACTIVATION_LEVELS);
  const commands: SlashCommand[] = [
    { name: "help", description: t("tui.command.help.description") },
    { name: "gateway-status", description: t("tui.command.gatewayStatus.description") },
    { name: "gwstatus", description: t("tui.command.gatewayStatusAlias.description") },
    ...(options.local ? [{ name: "auth", description: t("tui.command.auth.description") }] : []),
    { name: "agent", description: t("tui.command.agent.description") },
    { name: "agents", description: t("tui.command.agents.description") },
    { name: "openclaw", description: t("tui.command.openclaw.description") },
    { name: "session", description: t("tui.command.session.description") },
    { name: "sessions", description: t("tui.command.sessions.description") },
    {
      name: "model",
      description: t("tui.command.model.description"),
    },
    { name: "models", description: t("tui.command.models.description") },
    {
      name: "think",
      description: t("tui.command.think.description"),
      getArgumentCompletions: (prefix) =>
        thinkLevels
          .filter((v) => v.startsWith(normalizeLowercaseStringOrEmpty(prefix)))
          .map((value) => ({ value, label: value })),
    },
    {
      name: "fast",
      description: t("tui.command.fast.description"),
      getArgumentCompletions: fastCompletions,
    },
    {
      name: "verbose",
      description: t("tui.command.verbose.description"),
      getArgumentCompletions: verboseCompletions,
    },
    {
      name: "trace",
      description: t("tui.command.trace.description"),
      getArgumentCompletions: traceCompletions,
    },
    {
      name: "reasoning",
      description: t("tui.command.reasoning.description"),
      getArgumentCompletions: reasoningCompletions,
    },
    {
      name: "usage",
      description: t("tui.command.usage.description"),
      getArgumentCompletions: usageCompletions,
    },
    {
      name: "elevated",
      description: t("tui.command.elevated.description"),
      getArgumentCompletions: elevatedCompletions,
    },
    {
      name: "elev",
      description: t("tui.command.elevatedAlias.description"),
      getArgumentCompletions: elevatedCompletions,
    },
    {
      name: "activation",
      description: t("tui.command.activation.description"),
      getArgumentCompletions: activationCompletions,
    },
    { name: "abort", description: t("tui.command.abort.description") },
    { name: "new", description: t("tui.command.new.description") },
    { name: "reset", description: t("tui.command.reset.description") },
    { name: "settings", description: t("tui.command.settings.description") },
    { name: "exit", description: t("tui.command.exit.description") },
    { name: "quit", description: t("tui.command.exit.description") },
  ];

  const seen = new Set(commands.map((command) => command.name));
  const gatewayCommands = options.cfg ? listChatCommandsForConfig(options.cfg) : listChatCommands();
  for (const command of gatewayCommands) {
    if (
      options.local &&
      !seen.has(command.key) &&
      !LOCAL_TUI_ROUTED_SHARED_COMMANDS.has(command.key)
    ) {
      continue;
    }
    const aliases = command.textAliases.length > 0 ? command.textAliases : [`/${command.key}`];
    for (const alias of aliases) {
      appendSlashCommand(commands, seen, alias, command.description);
    }
  }

  for (const command of options.dynamicCommands ?? []) {
    const aliases = command.textAliases?.length ? command.textAliases : [command.name];
    for (const alias of aliases) {
      appendSlashCommand(commands, seen, alias, command.description);
    }
  }

  return commands;
}

export function helpText(options: SlashCommandOptions = {}): string {
  const localization = options.localization ?? TUI_ENGLISH_LOCALIZATION;
  const thinkLevels = formatThinkingLevels(
    options.provider,
    options.model,
    "|",
    undefined,
    options.agentRuntime,
  );
  return [
    localization.t("tui.command.help.heading"),
    "/help",
    ...(options.local ? [] : ["/commands", "/status"]),
    "/gateway-status",
    "/gwstatus",
    ...(options.local ? ["/auth [provider]"] : []),
    "/agent <id> (or /agents)",
    "/openclaw [request]",
    "/session <key> (or /sessions)",
    "/model <provider/model> (or /models)",
    `/think <${thinkLevels}>`,
    "/fast <status|auto|on|off>",
    "/verbose <on|off>",
    "/trace <on|off>",
    "/reasoning <on|off>",
    "/usage <off|tokens|full|reset|inherit|clear|default>",
    "/elevated <on|off|ask|full>",
    "/elev <on|off|ask|full>",
    "/activation <mention|always>",
    "/new or /reset",
    "/abort",
    "/settings",
    "/exit",
  ].join("\n");
}
