# pi-collapse

为 [pi coding agent](https://github.com/earendil-works/pi) 的 TUI 提供一套折叠能力，集中在**一个扩展、一个命令**下。

## 功能

| 功能 | 配置键 | 说明 |
|---|---|---|
| 思考自动折叠 | `thinking` | 模型思考时展开，开始输出正文 / 工具后自动折叠，标签显示 `Thinking >` |
| 长命令折叠 | `cmdlines` | 命令行超过 N 行或 M 字符时折叠成一行摘要（`write x.py` / `python heredoc` / `python -c` / 首条命令） |
| 高危命令提示 | `danger` | 识别 `rm -rf /`、`dd of=/dev/*`、`git push --force`、`DROP TABLE`、`curl\|bash` 等，命令行前加 `⚠ 说明`；只提示、不拦截 |
| 对话流折叠 | `transcript` | 每轮对话除最后回复外，其余过程合并成一个折叠块 `> N 项 · 点击展开`；展开后末尾有 `^ 收起` 可点回 |
| 最小输出 | `minimalOutput` | 折叠态隐藏 `bash`/`powershell`/`read`/`find`/`grep`/`ls` 的输出，`Ctrl+O` 展开才显示 |

## 命令

```
/collapse          # 切换总开关（全部折叠功能 开 / 关）
/collapse on       # 显式开启
/collapse off      # 显式关闭（恢复 pi 原生显示）
```

## 配置

所有细项都在 **`~/.pi/agent/collapse.json`**（唯一真源，改完 `/reload` 生效）：

```json
{
  "enabled": true,
  "thinking": true,
  "cmdlines": true,
  "cmdlinesMaxLines": 5,
  "cmdlinesMaxChars": 200,
  "transcript": true,
  "danger": true,
  "minimalOutput": true
}
```

- `enabled`：总开关；`false` = 完全恢复 pi 原生行为
- `cmdlinesMaxLines` / `cmdlinesMaxChars`：任一超阈值即折叠（`0` = 该阈值不启用）
- 首次运行会写出完整默认模板，并自动从旧的三个状态文件迁移

## 安装

方式一：让 pi 直接加载本文件，在 `~/.pi/agent/settings.json` 里加：

```json
{
  "extensions": ["~/Dev/pi-collapse/collapse.ts"]
}
```

方式二：把 `collapse.ts` 复制到 `~/.pi/agent/extensions/` 下（自动发现）。

改完 `/reload` 生效。

## 接口依赖

**公开 API**（pi 文档承诺）：`pi.on(...)`（事件）、`pi.registerTool()`、`pi.registerCommand()`、
`ctx.ui.notify()`、`ctx.ui.setHiddenThinkingLabel()`、`createBashTool()` / `createPowerShellTool()`
+ 工具 `renderCall` / `renderResult`、`getAgentDir()`、pi-tui 的 `Container` / `Text` / `Spacer`。

**内部实现**（未文档化，pi 升级可能变，已做防御式处理、失效时静默退回原生）：

- `AssistantMessageComponent.prototype.updateContent` 及 `hideThinkingBlock` / `thinkingVisibilityOverrides`
- `InteractiveMode.prototype.run` / `addMessageToChat`，字段 `chatContainer` / `ui`
- `chatContainer.children` + 组件识别（`instanceof` 优先，类名兜底）
- `Container.prototype.handleMouse`
- `ToolExecutionComponent.prototype.getResultRenderer`，字段 `toolName` / `expanded`

所有 patch 都在每次扩展加载时重装（记录最初实现，避免嵌套），`/reload` 后跑的是新代码。

## 仅影响 TUI

交互模式生效；RPC / print 模式无副作用。
