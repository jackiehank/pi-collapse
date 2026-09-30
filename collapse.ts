/**
 * Collapse bundle — pi extension
 *
 * 把三个折叠功能合并到一个扩展、一个命令下：
 *
 * 1. 思考折叠（thinking）
 *    模型思考时展开，开始输出正文 / 工具调用后自动折叠；
 *    折叠标签显示为 `Thinking >`。
 *
 * 2. 长命令折叠 + 高危命令提示（cmdlines / danger）
 *    - 命令行超过 N 行、或超过 M 字符时折叠成**一行摘要**（摘要过长会截断）：
 *        写文件 → `write script.py`；heredoc → `python heredoc`；
 *        `python -c` / `node -e` → 原样；其它 → 第一条有意义的命令行；
 *        并附 `(N lines, ctrl+o to expand)`。
 *      `Ctrl+O` 展开完整命令。
 *    - 识别常见危险命令（`rm -rf /`、`dd of=/dev/…`、`git push --force`、
 *      `DROP TABLE`、`curl … | bash` 等），在命令行前加 `⚠ 说明`：
 *      高危红色、中危黄色。只做提示，**不拦截执行**。
 *
 * 3. 对话流折叠（transcript）
 *    每一轮对话里，除最后那段 AI 文字回复外，其它内容（思考、工具、`!` 命令、
 *    摘要等）合并成一个折叠块，只显示一行 `> N 项 · 点击展开`；点击展开 / 折叠。
 *    展开后末尾还有一个 `^ 收起（N 项）` 行，滚到底点一下就能折回。
 *
 * 4. 最小输出（minimalOutput，**仅配置项**）
 *    折叠态（未展开）时 `bash` / `powershell` / `read` / `find` / `grep` / `ls`
 *    的**输出完全不显示**，只留调用行（含我们折叠后的命令行摘要）；
 *    `Ctrl+O` / 点击展开后才显示完整输出。
 *    默认开启，可在 `collapse.json` 里设 `"minimalOutput": false` 关闭。
 *    不进 `/collapse` 菜单，也没有命令。
 *
 * 命令
 * ----
 * `/collapse`          切换总开关（全部折叠功能 开 / 关）
 * `/collapse on|off`   显式设置
 *
 * 配置
 * ----
 * 所有细项都在 `~/.pi/agent/collapse.json`（唯一真源，改完 `/reload` 生效）：
 *   enabled / thinking / cmdlines / cmdlinesMaxLines / cmdlinesMaxChars
 *   transcript / danger / minimalOutput
 * 首次运行会写出完整默认模板（全开），并自动从旧的三个状态文件迁移。
 *
 * 接口依赖
 * --------
 * 公开 API（pi 文档承诺，安全）：
 *   - `pi.on(...)`，事件：session_start / before_agent_start / agent_start /
 *     turn_start / message_start / tool_execution_start / agent_end / agent_settled
 *   - `pi.registerTool()` / `pi.registerCommand()`
 *   - `ctx.ui.notify()` / `ctx.ui.setHiddenThinkingLabel()`
 *   - `createBashTool()` / `createPowerShellTool()` + 工具 `renderCall` / `renderResult`
 *   - `getAgentDir()`
 *   - `@earendil-works/pi-tui` 的 `Container` / `Text` / `Spacer`
 *
 * 内部实现（未文档化，pi 升级可能变；均为防御式，失效时静默退回原生）：
 *   - `AssistantMessageComponent.prototype.updateContent` 及字段
 *     `hideThinkingBlock` / `thinkingVisibilityOverrides` / `setHideThinkingBlock`
 *   - `InteractiveMode.prototype.run` / `addMessageToChat`，字段 `chatContainer` / `ui`
 *   - `chatContainer.children` + 按组件类识别（`instanceof` 优先，类名兜底）
 *   - `Container.prototype.handleMouse`（点击展开 / 收起）
 *   - `ToolExecutionComponent.prototype.getResultRenderer`，字段 `toolName` / `expanded`
 *   - 依赖 pi 在渲染时给扩展工具自动补内置 `renderResult`
 *
 * 说明
 * ----
 * - 所有 patch 都是防御式的：方法不存在就跳过，识别失败就退回原生显示，不影响 pi 本身。
 * - 每次扩展加载都会重装 patch（记录最初实现，避免嵌套），所以 `/reload` 后跑的是新代码。
 * - 仅影响 TUI（交互模式）；RPC / print 模式无副作用。
 *
 * 启用
 * ----
 * 源码在 `~/Dev/pi-collapse/`；pi 通过 `~/.pi/agent/settings.json` 的 `extensions`
 * 指向本文件加载。改完 `/reload` 生效。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	InteractiveMode,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	createBashTool,
	createPowerShellTool,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

// =====================================================================
// 配置状态
// =====================================================================

const AGENT_DIR = getAgentDir();
const STATE_FILE = join(AGENT_DIR, "collapse.json");
const DEFAULT_MAX_LINES = 5;
const DEFAULT_MAX_CHARS = 200;
/** 摘要行最长字符数，超过则截断。 */
const SUMMARY_MAX_CHARS = 100;
/** 整轮结束后延迟折叠的毫秒数：留点缓冲，避免刚好输出完就收起。 */
const COLLAPSE_DELAY_MS = 600;

interface Config {
	/** 总开关；关闭 = 恢复 pi 原生显示 */
	enabled: boolean;
	/** 思考自动折叠 */
	thinking: boolean;
	/** 长命令折叠 */
	cmdlines: boolean;
	/** 长命令折叠行数阈值 */
	cmdlinesMaxLines: number;
	/** 长命令折叠字符数阈值（0 = 不按字符折） */
	cmdlinesMaxChars: number;
	/** 对话流过程折叠 */
	transcript: boolean;
	/** 高危命令识别 / 高亮 */
	danger: boolean;
	/** 折叠态隐藏工具输出（minimal 模式）；仅配置项，不进菜单 */
	minimalOutput: boolean;
	/** 界面语言：auto（按环境推断）/ en / zh */
	lang: "auto" | "en" | "zh";
}

/** 从旧版三个状态文件迁移（仅在新状态文件不存在时使用）。 */
function migrateLegacy(): Config {
	const config: Config = {
		enabled: true,
		thinking: true,
		cmdlines: true,
		cmdlinesMaxLines: DEFAULT_MAX_LINES,
		cmdlinesMaxChars: DEFAULT_MAX_CHARS,
		transcript: true,
		danger: true,
		minimalOutput: true,
		lang: "auto",
	};
	const legacy: { file: string; apply: (raw: any) => void }[] = [
		{
			file: join(AGENT_DIR, "auto-collapse-thinking.json"),
			apply: (raw) => {
				if (typeof raw?.enabled === "boolean") config.thinking = raw.enabled;
			},
		},
		{
			file: join(AGENT_DIR, "collapse-long-command.json"),
			apply: (raw) => {
				if (typeof raw?.enabled === "boolean") config.cmdlines = raw.enabled;
				if (typeof raw?.maxLines === "number" && Number.isFinite(raw.maxLines) && raw.maxLines > 0) {
					config.cmdlinesMaxLines = Math.floor(raw.maxLines);
				}
			},
		},
		{
			file: join(AGENT_DIR, "collapse-transcript.json"),
			apply: (raw) => {
				if (typeof raw?.enabled === "boolean") config.transcript = raw.enabled;
			},
		},
	];
	for (const { file, apply } of legacy) {
		try {
			if (existsSync(file)) apply(JSON.parse(readFileSync(file, "utf8")));
		} catch {
			/* 忽略损坏的旧状态文件 */
		}
	}
	return config;
}

function normalize(raw: Partial<Config> | undefined, base: Config): Config {
	return {
		enabled: typeof raw?.enabled === "boolean" ? raw.enabled : base.enabled,
		thinking: typeof raw?.thinking === "boolean" ? raw.thinking : base.thinking,
		cmdlines: typeof raw?.cmdlines === "boolean" ? raw.cmdlines : base.cmdlines,
		cmdlinesMaxLines:
			typeof raw?.cmdlinesMaxLines === "number" && Number.isFinite(raw.cmdlinesMaxLines) && raw.cmdlinesMaxLines > 0
				? Math.floor(raw.cmdlinesMaxLines)
				: base.cmdlinesMaxLines,
		cmdlinesMaxChars:
			typeof raw?.cmdlinesMaxChars === "number" && Number.isFinite(raw.cmdlinesMaxChars) && raw.cmdlinesMaxChars >= 0
				? Math.floor(raw.cmdlinesMaxChars)
				: base.cmdlinesMaxChars,
		transcript: typeof raw?.transcript === "boolean" ? raw.transcript : base.transcript,
		danger: typeof raw?.danger === "boolean" ? raw.danger : base.danger,
		minimalOutput: typeof raw?.minimalOutput === "boolean" ? raw.minimalOutput : base.minimalOutput,
		lang: raw?.lang === "en" || raw?.lang === "zh" ? raw.lang : base.lang,
	};
}

function loadConfig(): Config {
	try {
		if (existsSync(STATE_FILE)) {
			return normalize(JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<Config>, migrateLegacy());
		}
	} catch {
		/* 忽略损坏的状态文件 */
	}
	return migrateLegacy();
}

function saveConfig(config: Config): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		/* 写失败不影响当前会话 */
	}
}

const config = loadConfig();

/**
 * 取某方法的"最初实现"（只记一次）。
 * 每次扩展加载都重装包装，而不是用标记跳过，这样 /reload 后跑的是新代码，
 * 又不会层层嵌套。
 */
const ORIGINAL_PREFIX = "__piCollapseOriginal__";
function patchProto(proto: any, key: string): any {
	if (!proto) return undefined;
	const originalKey = ORIGINAL_PREFIX + key;
	if (typeof proto[originalKey] !== "function") {
		if (typeof proto[key] !== "function") return undefined;
		proto[originalKey] = proto[key];
	}
	return proto[originalKey];
}

// =====================================================================
// i18n
// =====================================================================

type Lang = "en" | "zh";

interface I18NStrings {
	foldClosed: (n: number) => string;
	foldOpen: (n: number) => string;
	foldFooter: (n: number) => string;
	expandHint: string;
	lines: (n: number) => string;
	chars: (n: number) => string;
	masterOn: string;
	masterOff: string;
	usage: string;
}

const I18N: Record<Lang, I18NStrings> = {
	en: {
		foldClosed: (n) => `> ${n} items · click to expand`,
		foldOpen: (n) => `v ${n} items · click to collapse`,
		foldFooter: (n) => `^ collapse (${n} items) · click to collapse`,
		expandHint: "ctrl+o to expand",
		lines: (n) => `${n} lines`,
		chars: (n) => `${n} chars`,
		masterOn: "Collapse bundle: on",
		masterOff: "Collapse bundle: off (pi native display restored)",
		usage: "Usage: /collapse [on|off]",
	},
	zh: {
		foldClosed: (n) => `> ${n} 项 · 点击展开`,
		foldOpen: (n) => `v ${n} 项 · 点击折叠`,
		foldFooter: (n) => `^ 收起（${n} 项）· 点击折叠`,
		expandHint: "ctrl+o 展开",
		lines: (n) => `${n} 行`,
		chars: (n) => `${n} 字符`,
		masterOn: "折叠：已开启",
		masterOff: "折叠：已关闭（恢复 pi 原生显示）",
		usage: "用法：/collapse [on|off]",
	},
};

/** `auto` 时按环境语言推断（PI_LANG / LC_* / LANG / 系统 locale），默认英文。 */
function detectLang(setting: string): Lang {
	if (setting === "en" || setting === "zh") return setting;
	const env = [process.env.PI_LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]
		.filter(Boolean)
		.join(" ");
	if (env) {
		if (/zh|hans|hant|cn/i.test(env)) return "zh";
		if (/en/i.test(env)) return "en";
	}
	try {
		if (/^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale ?? "")) return "zh";
	} catch {
		/* ignore */
	}
	return "en";
}

const lang: Lang = detectLang(config.lang);
const t: I18NStrings = I18N[lang];

/** 会话内的 UI 上下文（用于思考标签 / 通知）。 */
let sessionUi: any;
/** 交互模式实例的 TUI / 聊天容器（用于请求重绘、刷新已渲染的工具调用）。 */
let transcriptUi: any;
let transcriptChat: any;
/** 本次扩展加载是否已挂上 chat.render 包装。 */
let transcriptAttached = false;

/** 强制已渲染的工具调用重新执行 renderCall（让配置变更立即生效）。 */
function refreshToolCalls(): void {
	const children = transcriptChat?.children;
	if (!Array.isArray(children)) return;
	for (const child of children) {
		if (isInstanceOf(child, ToolExecutionComponent, "ToolExecutionComponent") && typeof child.updateDisplay === "function") {
			try {
				child.updateDisplay();
			} catch {
				/* 单个组件刷新失败不影响其它 */
			}
		}
	}
}

function refreshAll(): void {
	refreshThinking();
	refreshToolCalls();
	transcriptUi?.requestRender?.();
}

// =====================================================================
// 功能 1：思考自动折叠
// =====================================================================

const HIDDEN_LABEL = "Thinking >";
/** 被思考折叠接管过的消息组件（用于切换开关时即时刷新）。 */
const thinkingTouched = new Set<any>();

/** 按内置逻辑收集 thinking run 序号（连续 thinking 块算同一个 run）。 */
function collectThinkingRuns(content: any[]): number[] {
	const runs: number[] = [];
	let runIndex = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] && content[i].type === "thinking") {
			while (i < content.length && content[i] && content[i].type === "thinking") i++;
			i--; // 抵消外层 for 的 i++
			runs.push(runIndex++);
		}
	}
	return runs;
}

/** 最后一个内容块是否是一个"正在输出"的 thinking 块。 */
function isThinkingActive(content: any[]): boolean {
	const last = content[content.length - 1];
	return Boolean(last && last.type === "thinking" && typeof last.thinking === "string" && last.thinking.trim());
}

function applyThinkingLabel(): void {
	if (!sessionUi || typeof sessionUi.setHiddenThinkingLabel !== "function") return;
	if (config.enabled && config.thinking) sessionUi.setHiddenThinkingLabel(HIDDEN_LABEL);
	else sessionUi.setHiddenThinkingLabel();
}

/** 切换开关后刷新已经渲染出来的思考块。 */
function refreshThinking(): void {
	for (const component of thinkingTouched) {
		try {
			if (config.enabled && config.thinking) {
				component.__autoThinkingMessage = undefined;
				component.__autoRendered = false;
				component.__autoWasStreaming = false;
				if (component.lastMessage) component.updateContent(component.lastMessage, component.isStreaming);
			} else {
				component.setHideThinkingBlock(component.__autoOrigHide ?? false);
			}
		} catch {
			/* 单个组件刷新失败不影响其它组件 */
		}
	}
}

function installThinkingPatch(): void {
	const proto = (AssistantMessageComponent as unknown as { prototype: any })?.prototype;
	// 每次扩展加载都重装包装（保存最初实现），确保 /reload 后跑新代码。
	const originalUpdateContent = patchProto(proto, "updateContent");
	if (!originalUpdateContent) return;

	proto.updateContent = function (this: any, message: any, isStreaming: boolean = this.isStreaming) {
		if (!config.enabled || !config.thinking) {
			return originalUpdateContent.call(this, message, isStreaming);
		}

		if (message && Array.isArray(message.content) && message.content.length > 0) {
			const runs = collectThinkingRuns(message.content);
			if (runs.length > 0) {
				if (this.__autoOrigHide === undefined) {
					this.__autoOrigHide = this.hideThinkingBlock;
				}
				thinkingTouched.add(this);

				const sameMessage = this.__autoThinkingMessage === message;
				if (isStreaming) {
					// 流式中：只展开仍在输出的那段思考。
					const activeRun = isThinkingActive(message.content) ? runs[runs.length - 1] : -1;
					this.hideThinkingBlock = true;
					for (const run of runs) {
						if (run === activeRun) this.thinkingVisibilityOverrides.set(run, false);
						else this.thinkingVisibilityOverrides.delete(run);
					}
					this.__autoWasStreaming = true;
				} else {
					// 首次渲染（含历史重建）、或刚结束流式 → 折叠；
					// 同一消息的其它重渲染（点击 / resize / 主题 / Ctrl+T）→ 尊重现状。
					if (!this.__autoRendered || this.__autoWasStreaming || !sameMessage) {
						this.hideThinkingBlock = true;
						for (const run of runs) this.thinkingVisibilityOverrides.delete(run);
					}
					this.__autoWasStreaming = false;
				}
				this.__autoRendered = true;
			}
		}

		this.__autoThinkingMessage = message;
		return originalUpdateContent.call(this, message, isStreaming);
	};
}

// =====================================================================
// 功能 2：长命令折叠
// =====================================================================

type DangerLevel = "high" | "medium";
interface DangerRule {
	level: DangerLevel;
	label: string;
	labelEn: string;
	re: RegExp;
}

/**
 * 高危 / 中危命令模式。按数组顺序匹配，先命中的生效（因此高危排前面）。
 * 只用于"识别 + 高亮"，不拦截执行；命中后会在命令行前加 ⚠ 标记。
 */
const DANGER_RULES: DangerRule[] = [
	// ---- 高危 ----
	{ level: "high", label: "删除根/家目录", labelEn: "delete root/home", re: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/|~|\$HOME)(?:\s|\/|\*|$)/i },
	{ level: "high", label: "写入块设备", labelEn: "write to block device", re: /\bdd\b[^\n]*\bof=\/dev\//i },
	{ level: "high", label: "格式化文件系统", labelEn: "format filesystem", re: /\bmkfs(?:\.\w+)?\b\s/i },
	{ level: "high", label: "擦除文件系统签名", labelEn: "wipe filesystem signatures", re: /\bwipefs\b/i },
	{ level: "high", label: "fork 炸弹", labelEn: "fork bomb", re: /:\s*\(\s*\)\s*\{/ },
	{ level: "high", label: "开放根目录权限", labelEn: "world-writable root", re: /\bchmod\s+(?:-R\s+)?[0-7]?777\s+(?:\/|\*)/i },
	{ level: "high", label: "递归改属主", labelEn: "recursive chown", re: /\bchown\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*R[a-zA-Z]*\s+[^\n]*\s(?:\/|~)(?:\s|\/|$)/ },
	{ level: "high", label: "格式化盘符", labelEn: "format drive", re: /\bformat\s+[a-z]:/i },
	{ level: "high", label: "Windows 递归强删", labelEn: "force recursive delete (Windows)", re: /\b(?:del|erase)\b[^\n]*\/[fsq]/i },
	{ level: "high", label: "Windows 删除目录树", labelEn: "delete directory tree (Windows)", re: /\b(?:rd|rmdir)\b[^\n]*\/s/i },
	{ level: "high", label: "PowerShell 递归强删", labelEn: "force recursive delete (PowerShell)", re: /\bRemove-Item\b[^\n]*-(?:Recurse|Force)\b/i },
	{ level: "high", label: "关机/重启系统", labelEn: "shutdown / reboot", re: /\b(?:shutdown\s+-[a-z]*[hr]|reboot|halt|Stop-Computer|Restart-Computer)\b/i },
	// ---- 中危 ----
	{ level: "medium", label: "递归/强制删除", labelEn: "recursive/force delete", re: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\b/i },
	{ level: "medium", label: "强制推送", labelEn: "force push", re: /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)/i },
	{ level: "medium", label: "硬重置", labelEn: "hard reset", re: /\bgit\s+reset\s+--hard\b/i },
	{ level: "medium", label: "清理未跟踪文件", labelEn: "git clean", re: /\bgit\s+clean\s+-[a-z]*[fdx]/i },
	{ level: "medium", label: "删除分支", labelEn: "delete branch", re: /\bgit\s+branch\s+-D\b/ },
	{ level: "medium", label: "删除数据库/表", labelEn: "drop database/table", re: /\b(?:drop\s+(?:database|table)|truncate\s+table)\b/i },
	{ level: "medium", label: "无 WHERE 的 DELETE", labelEn: "DELETE without WHERE", re: /\bdelete\s+from\b(?![^;]*\bwhere\b)/i },
	{ level: "medium", label: "Docker 清理", labelEn: "docker prune", re: /\bdocker\s+(?:system\s+prune|volume\s+prune|rmi)\b/i },
	{ level: "medium", label: "kubectl 删除", labelEn: "kubectl delete", re: /\bkubectl\s+delete\b/i },
	{ level: "medium", label: "terraform destroy", labelEn: "terraform destroy", re: /\bterraform\s+destroy\b/i },
	{ level: "medium", label: "S3 递归删除", labelEn: "recursive S3 delete", re: /\baws\s+s3\s+rm\b[^\n]*--recursive/i },
	{ level: "medium", label: "发布到 npm", labelEn: "npm publish", re: /\bnpm\s+publish\b/i },
	{ level: "medium", label: "下载并执行远程脚本", labelEn: "pipe remote script to shell", re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i },
	{ level: "medium", label: "eval 执行字符串", labelEn: "eval", re: /\beval\b/ },
	{ level: "medium", label: "放开执行策略", labelEn: "relax execution policy", re: /\bSet-ExecutionPolicy\s+(?:Unrestricted|Bypass)\b/i },
	{ level: "medium", label: "Invoke-Expression", labelEn: "Invoke-Expression", re: /\b(?:Invoke-Expression|iex)\b/i },
	{ level: "medium", label: "监听端口", labelEn: "listen on port", re: /\bnc\s+-l/i },
];

/** 检出命令中的高危 / 中危模式（返回第一条命中的规则）。 */
function detectDanger(command: string): DangerRule | null {
	for (const rule of DANGER_RULES) {
		if (rule.re.test(command)) return rule;
	}
	return null;
}

/** 常见脚本解释器（用于识别内联脚本）。 */
const INTERPRETERS = new Set([
	"python",
	"python2",
	"python3",
	"node",
	"bun",
	"deno",
	"ruby",
	"perl",
	"php",
	"osascript",
	"pwsh",
	"powershell",
	"bash",
	"sh",
	"zsh",
]);

function shortName(path: string): string {
	return path.replace(/^['"]|['"]$/g, "").split(/[\\/]/).pop() || path;
}

/** 跳过 shebang / 注释 / set 开头，找到第一条真正的命令。 */
function firstMeaningfulLine(lines: string[]): string {
	for (const line of lines) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		if (/^set\s+[-+]/.test(t)) continue;
		return t;
	}
	return (lines[0] ?? "").trim();
}

/**
 * 为超长命令生成一行摘要（B + D-lite）：
 * - 写文件（`cat > f` / `tee f` / `>> log`）→ `write f`
 * - heredoc（`python - <<'PY'`）→ `python heredoc`
 * - 内联脚本（`python -c` / `node -e`）→ `python -c`
 * - 其它 → 第一条有意义的命令行
 */
function summarizeCommand(command: string): string {
	const head = firstMeaningfulLine(command.split("\n"));
	if (!head) return "";

	const writeMatch = head.match(/\btee\s+(?:-a\s+)?([^\s;&|]+)/) || head.match(/>{1,2}\s*([^\s;&|]+)/);
	const target = writeMatch?.[1];
	if (target && !target.startsWith("&") && !target.startsWith(">")) return `write ${shortName(target)}`;

	const tokens = head.split(/\s+/);
	const cmd0 = shortName(tokens[0] ?? "");

	if (command.includes("<<")) return `${cmd0} heredoc`;

	const flag = tokens.slice(1).find((t) => t === "-c" || t === "-e" || t === "--eval");
	if (INTERPRETERS.has(cmd0) && flag) return `${cmd0} ${flag}`;

	return head;
}

/** 自定义命令行渲染：超长时折叠成一行摘要。 */
function makeRenderCall(prompt: string) {
	return (args: any, theme: Theme, context: any) => {
		const state = context?.state;
		if (context?.executionStarted && state && state.startedAt === undefined) {
			state.startedAt = Date.now();
			state.endedAt = undefined;
		}

		const text: Text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);

		const timeout = args?.timeout;
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

		const command = typeof args?.command === "string" ? args.command : null;
		let display: string;
		if (command === null) display = theme.fg("error", "<invalid command>");
		else if (command.length === 0) display = theme.fg("toolOutput", "...");
		else display = command;

		if (config.enabled && config.cmdlines && command && !context?.expanded) {
			const lines = command.split("\n");
			const overLines = config.cmdlinesMaxLines > 0 && lines.length > config.cmdlinesMaxLines;
			const overChars = config.cmdlinesMaxChars > 0 && command.length > config.cmdlinesMaxChars;
			if (overLines || overChars) {
				const summary = summarizeCommand(command) || lines[0] || "";
				const short = summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary;
				const detail = lines.length > 1 ? t.lines(lines.length) : t.chars(command.length);
				display = `${short}${theme.fg("muted", `  (${detail}, ${t.expandHint})`)}`;
			}
		}

		// 高危命令识别：在命令行前加 ⚠ 标记（折叠 / 展开都可见）。
		const danger = config.enabled && config.danger && command ? detectDanger(command) : null;
		const badge = danger
			? theme.fg(
					danger.level === "high" ? "error" : "warning",
					`⚠ ${lang === "zh" ? danger.label : danger.labelEn}  `,
				)
			: "";

		text.setText(
			`${theme.fg("toolTitle", theme.bold(`${prompt} `))}${badge}${theme.fg("toolTitle", theme.bold(display))}${timeoutSuffix}`,
		);
		return text;
	};
}

function installCommandLineTools(pi: ExtensionAPI): void {
	const cache = new Map<string, any>();
	const cached = (key: string, cwd: string, create: (cwd: string) => any) => {
		let tool = cache.get(key);
		if (!tool) {
			tool = create(cwd);
			cache.set(key, tool);
		}
		return tool;
	};

	const bashTemplate = createBashTool(process.cwd());
	pi.registerTool({
		...bashTemplate,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = (ctx as any)?.cwd ?? process.cwd();
			return cached(`bash:${cwd}`, cwd, createBashTool).execute(toolCallId, params, signal, onUpdate);
		},
		// 只替换命令行渲染；结果渲染由 pi 自动补上内置实现。
		renderCall: makeRenderCall("$"),
	});

	const psTemplate = createPowerShellTool(process.cwd());
	pi.registerTool({
		...psTemplate,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = (ctx as any)?.cwd ?? process.cwd();
			return cached(`powershell:${cwd}`, cwd, createPowerShellTool).execute(toolCallId, params, signal, onUpdate);
		},
		renderCall: makeRenderCall("PS>"),
	});
}

// =====================================================================
// 功能 3：对话流过程折叠
// =====================================================================

/** 组件实例级标记：render 包装已安装。 */
const RENDER_WRAPPED = "__piFoldRenderWrapped";

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/** 每个折叠块的展开状态，key 为该轮的起始组件（用户消息或段首组件）。 */
interface GroupEntry {
	collapsed: boolean;
	/** 上次算法期望的折叠状态；用于判断"轮状态"是否变化。 */
	desired: boolean;
	count: number;
}
const groupState = new Map<object, GroupEntry>();

/**
 * 本轮（一次用户输入触发的 agent 循环）是否仍在进行。
 *
 * 不能只看组件级 `isStreaming`：工具执行完到下一条消息开始之间、或一次工具往返结束时，
 * 所有组件都会短暂地"不在流式"，但那并不是最终回复。若据此折叠，就会出现
 * "先折叠、马上又展开"的抖动。这里用 agent 级事件把整轮活动钉住。
 */
let turnActive = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function cancelSettleTimer(): void {
	if (settleTimer !== undefined) {
		clearTimeout(settleTimer);
		settleTimer = undefined;
	}
}

function markTurnActive(active: boolean): void {
	if (turnActive === active) return;
	turnActive = active;
	transcriptUi?.requestRender?.();
}

/** agent_end / agent_settled 后延迟折叠：留出一点缓冲，避免刚好输出完就"啪"地收起。 */
function scheduleSettle(): void {
	cancelSettleTimer();
	settleTimer = setTimeout(() => {
		settleTimer = undefined;
		markTurnActive(false);
	}, COLLAPSE_DELAY_MS);
}

function nameOf(component: any): string {
	try {
		return component?.constructor?.name ?? "";
	} catch {
		return "";
	}
}

/**
 * 组件识别：优先 `instanceof`（扩展通过 pi 的虚拟模块拿到的是同一份类，最稳），
 * 类名作为兜底（万一导出缺失 / 实现变更，仍能靠名字识别）。
 */
function isInstanceOf(component: any, cls: any, name: string): boolean {
	try {
		if (cls && component instanceof cls) return true;
	} catch {
		/* cls 不可用（未导出）时忽略 */
	}
	return nameOf(component) === name;
}

const isUser = (c: any) => isInstanceOf(c, UserMessageComponent, "UserMessageComponent");
const isAssistant = (c: any) => isInstanceOf(c, AssistantMessageComponent, "AssistantMessageComponent");
const isSpacer = (c: any) => isInstanceOf(c, Spacer, "Spacer");

/** 归入折叠块的"过程"组件类型（instanceof + 类名兜底）。 */
const PROCESS_MATCHERS: ((c: any) => boolean)[] = [
	(c) => isInstanceOf(c, ToolExecutionComponent, "ToolExecutionComponent"),
	(c) => isInstanceOf(c, BashExecutionComponent, "BashExecutionComponent"),
	(c) => isInstanceOf(c, CompactionSummaryMessageComponent, "CompactionSummaryMessageComponent"),
	(c) => isInstanceOf(c, BranchSummaryMessageComponent, "BranchSummaryMessageComponent"),
	(c) => isInstanceOf(c, SkillInvocationMessageComponent, "SkillInvocationMessageComponent"),
];

/** assistant 消息里是否有可见的文字（作为最终回复保留）。 */
function hasVisibleText(component: any): boolean {
	const message = component?.lastMessage;
	if (!message || !Array.isArray(message.content)) return false;
	return message.content.some(
		(part: any) => part && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
	);
}

/** 这一轮是否还在流式输出中。 */
function isStreaming(component: any): boolean {
	return component?.isStreaming === true || component?.isPartial === true || component?.status === "running";
}

function isProcessCandidate(component: any): boolean {
	return PROCESS_MATCHERS.some((match) => match(component)) || isAssistant(component);
}

function ensureRenderOverride(component: any): void {
	if (component[RENDER_WRAPPED]) return;
	component[RENDER_WRAPPED] = true;

	const originalRender = component.render;
	component.render = function (this: any, width: number): string[] {
		const state = this.__foldState;
		if (!state) return originalRender.call(this, width);

		const entry = groupState.get(state.groupKey);
		const collapsed = entry ? entry.collapsed : true;
		const count = entry?.count ?? state.count ?? 0;
		const header = `${DIM}${collapsed ? t.foldClosed(count) : t.foldOpen(count)}${RESET}`;
		// 展开时在末尾追加一个"收起"按钮，滚到底顺手点一下就折回。
		const footer = `${DIM}${t.foldFooter(count)}${RESET}`;

		if (state.role === "hidden") {
			if (collapsed) return [];
			const lines = originalRender.call(this, width);
			return this.__foldFooter ? [...lines, footer] : lines;
		}
		// 折叠块的首个组件：负责渲染折叠行，展开时再追加自身内容。
		if (collapsed) return [header];
		const lines = originalRender.call(this, width);
		return this.__foldFooter ? [header, ...lines, footer] : [header, ...lines];
	};
}

function updateFoldRoles(children: any[]): void {
	for (const child of children) {
		if (child && typeof child === "object") {
			child.__foldState = undefined;
			child.__foldFooter = false;
		}
	}

	// 1. 按用户消息切分"轮"。
	const segments: { key: object; items: any[] }[] = [];
	let current: { key: object; items: any[] } | null = null;
	for (const child of children) {
		if (!child) continue;
		if (isUser(child)) {
			current = { key: child, items: [] };
			segments.push(current);
		} else {
			if (!current) {
				current = { key: child, items: [] };
				segments.push(current);
			}
			current.items.push(child);
		}
	}

	// 2. 每轮：保留最后一个含文字回复的 assistant，其余过程合并。
	const lastSegment = segments.length > 0 ? segments[segments.length - 1] : null;
	for (const segment of segments) {
		const replies = segment.items.filter((c) => isAssistant(c) && hasVisibleText(c));
		const kept = replies.length > 0 ? replies[replies.length - 1] : null;

		const process = segment.items.filter(
			(c) => c !== kept && !isUser(c) && !isSpacer(c) && isProcessCandidate(c),
		);

		if (process.length === 0) {
			groupState.delete(segment.key);
			continue;
		}

		const streaming = segment.items.some(isStreaming);
		// 只有"最新一轮且整轮仍在进行"才保持展开；历史轮一律折叠。
		// 用 agent 级 turnActive 而非组件级 streaming 判定，避免工具间隙的折叠抖动。
		const desired = !(streaming || (segment === lastSegment && turnActive));

		let entry = groupState.get(segment.key);
		if (!entry) {
			entry = { collapsed: desired, desired, count: process.length };
		} else if (entry.desired !== desired) {
			entry.collapsed = desired;
			entry.desired = desired;
		}
		entry.count = process.length;
		groupState.set(segment.key, entry);

		process.forEach((component, index) => {
			ensureRenderOverride(component);
			component.__foldState = {
				groupKey: segment.key,
				role: index === 0 ? "header" : "hidden",
				count: process.length,
			};
			component.__foldFooter = index === process.length - 1;
		});
	}
}

function clearFoldRoles(children: any[]): void {
	for (const child of children) {
		if (child && typeof child === "object") {
			child.__foldState = undefined;
			child.__foldFooter = false;
		}
	}
}

function attachTranscript(instance: any): void {
	if (transcriptAttached) return;
	const chat = instance?.chatContainer;
	const ui = instance?.ui;
	if (!chat || typeof chat.render !== "function" || !ui) return;

	transcriptAttached = true;
	transcriptUi = ui;
	transcriptChat = chat;

	// 每次扩展加载都重装包装（保存最初实现），确保 /reload 后跑新代码。
	const ORIGINAL_RENDER = "__piCollapseOriginalRender";
	if (typeof chat[ORIGINAL_RENDER] !== "function") chat[ORIGINAL_RENDER] = chat.render;
	const originalRender = chat[ORIGINAL_RENDER];
	chat.render = function (this: any, width: number): string[] {
		try {
			if (config.enabled && config.transcript) updateFoldRoles(this.children ?? []);
			else clearFoldRoles(this.children ?? []);
		} catch {
			/* 分组失败时退回原生渲染 */
		}
		return originalRender.call(this, width);
	};
}

function installTranscript(): void {
	// 1. 捕获交互模式实例（run 最早，addMessageToChat 兜底）。
	const proto = (InteractiveMode as any)?.prototype;
	const originalRun = patchProto(proto, "run");
	if (originalRun) {
		proto.run = function (this: any, ...args: any[]) {
			try {
				attachTranscript(this);
			} catch {
				/* 实例结构变化时忽略 */
			}
			return originalRun.apply(this, args);
		};
	}
	const originalAdd = patchProto(proto, "addMessageToChat");
	if (originalAdd) {
		proto.addMessageToChat = function (this: any, ...args: any[]) {
			const result = originalAdd.apply(this, args);
			try {
				attachTranscript(this);
			} catch {
				/* 实例结构变化时忽略 */
			}
			return result;
		};
	}

	// 2. 点击折叠行切换展开 / 折叠（头部或末尾的“收起”行）。
	const cproto = Container.prototype as any;
	const originalHandleMouse = patchProto(cproto, "handleMouse");
	if (originalHandleMouse) {
		cproto.handleMouse = function (this: any, event: any) {
			const state = this?.__foldState;
			if (state && event && event.type === "click" && event.button === "left") {
				const entry = groupState.get(state.groupKey);
				if (entry) {
					const headerClick = state.role === "header" && event.y === 0;
					const footerClick =
						this.__foldFooter === true && !entry.collapsed && event.y === event.height - 1;
					if (headerClick || footerClick) {
						entry.collapsed = !entry.collapsed;
						this.invalidate?.();
						transcriptUi?.requestRender?.();
						return { handled: true };
					}
				}
			}
			return originalHandleMouse.call(this, event);
		};
	}
}

// =====================================================================
// 功能 4：最小输出（折叠态隐藏工具输出）
// =====================================================================

/**
 * 参与"最小输出"的工具：折叠态（未展开）时**输出完全不渲染**，只留调用行；
 * `Ctrl+O` / 点击展开后才显示完整输出。
 * `edit` / `write` 被 SoL-Pi 覆盖，这里先不碰。
 */
const MINIMAL_OUTPUT_TOOLS = new Set(["bash", "powershell", "read", "find", "grep", "ls"]);

function installMinimalOutput(): void {
	const proto = (ToolExecutionComponent as any)?.prototype;
	// 每次扩展加载都重装包装（保存最初实现），确保 /reload 后跑新代码。
	const originalGetResultRenderer = patchProto(proto, "getResultRenderer");
	if (!originalGetResultRenderer) return;
	proto.getResultRenderer = function (this: any) {
		const original = originalGetResultRenderer.call(this);
		if (typeof original !== "function") return original;
		return (result: any, options: any, theme: any, context: any) => {
			if (config.enabled && config.minimalOutput && !options?.expanded && MINIMAL_OUTPUT_TOOLS.has(this.toolName)) {
				return new Text("", 0, 0);
			}
			return original(result, options, theme, context);
		};
	};
}

// =====================================================================
// 命令
// =====================================================================

/**
 * 命令：只保留一个总开关。
 *
 * `/collapse`        切换总开关（全部折叠功能 开 / 关）
 * `/collapse on|off` 显式设置
 *
 * 其余细项（各功能开关、行数 / 字符数阈值、minimalOutput 等）只在配置文件里改：
 *   ~/.pi/agent/collapse.json
 */
function applyMasterSwitch(enabled: boolean, ctx: any): void {
	config.enabled = enabled;
	saveConfig(config);
	applyThinkingLabel();
	refreshAll();
	ctx.ui.notify(enabled ? t.masterOn : t.masterOff);
}

// =====================================================================
// 扩展入口
// =====================================================================

export default function collapseBundle(pi: ExtensionAPI): void {
	installThinkingPatch();
	installCommandLineTools(pi);
	installTranscript();
	installMinimalOutput();

	// 轮活跃跟踪：避免工具 / 消息间隙被误判为"轮结束"而折叠抖动。
	const markActive = () => {
		cancelSettleTimer();
		markTurnActive(true);
	};
	pi.on("before_agent_start", markActive);
	pi.on("agent_start", markActive);
	pi.on("turn_start", markActive);
	pi.on("message_start", markActive);
	pi.on("tool_execution_start", markActive);
	pi.on("agent_end", () => scheduleSettle());
	pi.on("agent_settled", () => {
		// 整轮真正结束：延迟一小段再折叠，避免刚好输出完就收起来。
		scheduleSettle();
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionUi = ctx.ui;
		turnActive = false;
		cancelSettleTimer();
		// 始终写回，让新配置项（如 minimalOutput）出现在文件里方便手改。
		saveConfig(config);
		applyThinkingLabel();
	});

	pi.registerCommand("collapse", {
		description: "Collapse bundle master switch: /collapse [on|off] (details in collapse.json)",
		handler: async (args, ctx) => {
			sessionUi = ctx.ui;
			const arg = args.trim().toLowerCase();
			if (arg === "on") applyMasterSwitch(true, ctx);
			else if (arg === "off") applyMasterSwitch(false, ctx);
			else if (arg === "") applyMasterSwitch(!config.enabled, ctx);
			else ctx.ui.notify(t.usage, "warning");
		},
	});
}
