# pi-collapse

**[English](README.md) | [简体中文](README.zh-CN.md)**

Collapsible thinking, commands and transcript for the [pi coding agent](https://github.com/earendil-works/pi) TUI — all behind a single `/collapse` command.

## Features

| Feature | Config key | Description |
|---|---|---|
| Thinking auto-collapse | `thinking` | Thinking expands while streaming, then collapses once the answer / tool starts. Collapsed label: `Thinking >`. |
| Long command fold | `cmdlines` | A shell command over N lines or M chars folds into a one-line summary (`write x.py`, `python heredoc`, `python -c`, or the first meaningful line). |
| Dangerous command hints | `danger` | Flags `rm -rf /`, `dd of=/dev/*`, `git push --force`, `DROP TABLE`, `curl … \| bash`, … with a `⚠ reason` badge. Hint only — never blocks execution. |
| Transcript collapse | `transcript` | In each turn, everything except the final assistant reply (thinking, tool calls, `!` commands, summaries) folds into one block `> N items · click to expand`. Expanded blocks have a clickable `^ collapse` row at the bottom. |
| Minimal output | `minimalOutput` | Hides the output of `bash` / `powershell` / `read` / `find` / `grep` / `ls` while collapsed; `Ctrl+O` expands. |

## Install

```bash
pi install git:github.com/jackiehank/pi-collapse
```

Then restart pi or run `/reload`.

Local development:

```bash
pi install ./pi-collapse
```

## Command

```
/collapse          # toggle the master switch (all folding on / off)
/collapse on       # enable
/collapse off      # disable (restore pi's native display)
```

## Configuration

Everything lives in `~/.pi/agent/collapse.json` (single source of truth; run `/reload` after editing):

```json
{
  "enabled": true,
  "thinking": true,
  "cmdlines": true,
  "cmdlinesMaxLines": 5,
  "cmdlinesMaxChars": 200,
  "transcript": true,
  "danger": true,
  "minimalOutput": true,
  "lang": "auto"
}
```

- `enabled` — master switch; `false` restores pi's native behavior.
- `cmdlinesMaxLines` / `cmdlinesMaxChars` — fold when either threshold is exceeded (`0` disables that threshold).
- `lang` — `auto` (detect from `PI_LANG` / `LC_*` / `LANG` / system locale), `en`, or `zh`.
- The file is written with a full default template on first run, and migrates settings from the older per-feature state files.

## Scope

Only the interactive TUI is affected. RPC / print modes are untouched.

## Interface dependencies

**Public API** (documented by pi): `pi.on(...)`, `pi.registerTool()`, `pi.registerCommand()`, `ctx.ui.notify()`, `ctx.ui.setHiddenThinkingLabel()`, `createBashTool()` / `createPowerShellTool()` + tool `renderCall` / `renderResult`, `getAgentDir()`, and pi-tui's `Container` / `Text` / `Spacer`.

**Internal implementation** (undocumented; may change across pi releases — handled defensively and falls back to native rendering): `AssistantMessageComponent.prototype.updateContent`, `InteractiveMode.prototype.run` / `addMessageToChat`, `Container.prototype.handleMouse`, `ToolExecutionComponent.prototype.getResultRenderer`, `chatContainer.children`.

Every patch is re-installed on each extension load (with the original method remembered, so nothing nests), so `/reload` always runs the latest code.

## License

[MIT](LICENSE)
