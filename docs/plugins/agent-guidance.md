---
summary: "Shared operator-managed instructions without rewriting agent workspace files"
read_when:
  - Maintaining shared instructions for selected agents
  - Configuring the Agent Guidance plugin
title: "Agent Guidance"
---

# Agent Guidance

Agent Guidance is an optional bundled plugin that adds operator-managed files
to selected agents' system context. It keeps shared instructions in one place
without patching OpenClaw's base prompt or rewriting AGENTS.md, TOOLS.md or
SOUL.md. Workspace instructions remain agent/user-owned.

## Configure

The plugin is disabled by default. Create an operator-controlled directory
outside agent-writable workspaces, protect its files and ancestor directories
with filesystem permissions, then add an entry to your configuration:

```json
{
  "plugins": {
    "entries": {
      "agent-guidance": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        },
        "config": {
          "directory": "/srv/agent-guidance",
          "agents": ["main"],
          "append": ["instructions.md"]
        }
      }
    }
  }
}
```

If you use `plugins.allow`, also include `agent-guidance` in that list. On
Windows, use an absolute Windows directory. The native `before_prompt_build`
hook requires both permissions above, although this plugin ignores event content.

Example `instructions.md`:

```text
When comparing proposals, distinguish observations from assumptions.
Finish with one short recommendation and its main tradeoff.
```

`agents` contains exact, case-sensitive agent IDs, not sender identities.
Unselected agents and hooks without an agent ID receive no contribution.
Instructions are sent to the configured model: never put secrets in them.

## Files And Placement

- `directory`: required absolute path. No environment expansion or workspace default.
- `agents`: 1 to 64 distinct explicit agent IDs.
- `prepend`: ordered relative file names added as `prependSystemContext`.
- `append`: ordered relative file names added as `appendSystemContext`.

Configure 1 to 8 files across both placements. Each must be a nonempty UTF-8
regular file of at most 16 KiB; combined contributions are limited to 64 KiB,
including the two newlines between files in each placement. Oversized content
is rejected, not truncated. The model's context limits still apply.

File names use forward slashes, letters, digits, dots, underscores and hyphens.
Traversal, duplicate names, symbolic/hard links, linked ancestor directories,
nonregular files, malformed UTF-8 and NULs are rejected. These checks do not
replace operator-managed permissions and are not a filesystem sandbox.

## Update And Disable

Files are read once at plugin registration. Editing a file alone does not change
the active snapshot. After editing, use native reload or restart:

```sh
openclaw plugins reload agent-guidance
```

Separately mounted instruction files can be updated without rebuilding the
plugin or image. Instructions baked into an immutable image still require a
new image. There is no file watcher, per-turn read or remote configuration fetch.

Disable future contributions with `openclaw plugins disable agent-guidance`;
re-enable with `openclaw plugins enable agent-guidance`. Previously submitted
prompts cannot be recalled. Existing conversations can see new instructions
after reload: this plugin does not pin instruction versions to sessions. Drain
existing sessions before updates when stable session prompts are required.

## Failure Behavior

A file-load error prevents registration of the entire contribution. Diagnostics
identify the file's configured position without printing paths or content.
OpenClaw can continue without a failed plugin: guidance is **not a fail-closed
policy gate**, tool authorization or a guarantee of model obedience.

Failed reload does not guarantee that the previous instructions stay active.
Native recovery restores plugin code/configuration, not external instruction
bytes. Keep a known-good copy under operator control. After a bad edit, restore
valid files, reload and verify the plugin before resuming dependent work.

See [Managing plugins](/plugins/manage-plugins) and
[Plugin architecture](/plugins/architecture) for native permissions and lifecycle.
