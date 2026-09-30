# pi-collapse

**[English](README.md) | [简体中文](README.zh-CN.md)**

为 [pi coding agent](https://github.com/earendil-works/pi) 的 TUI 提供折叠能力——思考、命令行、对话流，全部集中在一个 `/collapse` 命令下。

## 功能

| 功能 | 配置键 | 说明 |
|---|---|---|
| 思考自动折叠 | `thinking` | 模型思考时展开，开始输出正文 / 工具后自动折叠；折叠标签 `Thinking >`。 |
| 长命令折叠 | `cmdlines` | 命令行超过 N 行或 M 字符时折叠成一行摘要（`write x.py`、`python heredoc`、`python -c`，或第一条有意义的命令）。 |
| 高危命令提示 | `danger` | 识别 `rm -rf /`、`dd of=/dev/*`、`git push --force`、`DROP TABLE`、`curl … \| bash` 等，命令行前加 `⚠ 说明`。只提示，**不拦截执行**。 |
| 对话流折叠 | `transcript` | 每轮对话除最后回复外，其余过程（思考、工具、`!` 命令、摘要）合并成一个折叠块 `> N 项 · 点击展开`；展开后末尾有可点击的 `^ 收起` 行。 |
| 最小输出 | `minimalOutput` | 折叠态隐藏 `bash` / `powershell` / `read` / `find` / `grep` / `ls` 的输出；`Ctrl+O` 展开。 |

## 安装

```bash
pi install git:github.com/jackiehank/pi-collapse
```

然后重启 pi 或执行 `/reload`。

本地开发：

```bash
pi install ./pi-collapse
```

## 命令

```
/collapse          # 切换总开关（全部折叠功能 开 / 关）
/collapse on       # 开启
/collapse off      # 关闭（恢复 pi 原生显示）
```

## 配置

所有细项都在 `~/.pi/agent/collapse.json`（唯一真源，改完执行 `/reload`）：

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

- `enabled` — 总开关；`false` 恢复 pi 原生行为。
- `cmdlinesMaxLines` / `cmdlinesMaxChars` — 任一超阈值即折叠（`0` 表示该阈值不启用）。
- `lang` — `auto`（按 `PI_LANG` / `LC_*` / `LANG` / 系统 locale 推断）、`en` 或 `zh`。
- 首次运行会写出完整默认模板，并自动从旧的按功能拆分的状态文件迁移。

## 影响范围

仅影响交互式 TUI；RPC / print 模式不受影响。

## 接口依赖

**公开 API**（pi 文档承诺）：`pi.on(...)`、`pi.registerTool()`、`pi.registerCommand()`、`ctx.ui.notify()`、`ctx.ui.setHiddenThinkingLabel()`、`createBashTool()` / `createPowerShellTool()` + 工具 `renderCall` / `renderResult`、`getAgentDir()`，以及 pi-tui 的 `Container` / `Text` / `Spacer`。

**内部实现**（未文档化，pi 升级可能变；已做防御式处理，失效时静默退回原生）：`AssistantMessageComponent.prototype.updateContent`、`InteractiveMode.prototype.run` / `addMessageToChat`、`Container.prototype.handleMouse`、`ToolExecutionComponent.prototype.getResultRenderer`、`chatContainer.children`。

所有 patch 都在每次扩展加载时重装（记录最初实现，避免嵌套），因此 `/reload` 后跑的始终是最新代码。

## 许可证

[MIT](LICENSE)
