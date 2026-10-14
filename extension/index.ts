/**
 * Model Router extension — escalation architecture.
 *
 * The user defines a CHEAP and a CAPABLE model. Every request starts on the
 * cheap model. Escalation to the capable model happens *during* the run,
 * either because the model asks for it or because an encoder model predicts
 * the run is failing:
 *
 *   1. Tool escalation — the cheap model gets an `escalate` tool it can call
 *      when it decides the task is beyond it ("this needs a stronger model").
 *   2. Encoder escalation — after each turn, a compact summary of the run so
 *      far (tools called, failures, repetition, last output) is sent to the
 *      laya encoder (convaiinnovations/laya via `laya-serve`), which returns
 *      the calibrated probability that the cheap model will fail the task;
 *      above `escalation.encoder.threshold`, the extension escalates.
 *
 * `escalation.mode` picks the mechanism: "tool", "encoder", or "both".
 *
 * One-shot pins still exist: `!big <msg>` starts the next request on the
 * capable model, `!small <msg>` forces cheap. If the user picks a model
 * manually (/model, Ctrl+P), auto-routing pauses until `/router auto`.
 *
 * Config: ~/.pi/agent/model-router.json (global) and <cwd>/.pi/model-router.json
 * (project). See model-router.example.json and README.md.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

type Tier = "cheap" | "capable";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type EscalationMode = "tool" | "encoder" | "both";

interface TierModel {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

interface ToolConfig {
	/** Append a hint to the system prompt telling the model the tool exists */
	promptHint: boolean;
}

interface EncoderConfig {
	enabled: boolean;
	url: string;
	apiKey?: string;
	timeoutMs: number;
	/** Calibrated P(cheap model will fail) needed to escalate */
	threshold: number;
	/** Below this answer confidence, never escalate */
	minConfidence: number;
	/** Check the trajectory every N turns (1 = every turn) */
	checkEvery: number;
	/** Give up on encoder checks after this many (the signal saturates) */
	maxChecks: number;
	/** The noul statement sent to laya; escalate prob = P(statement true) */
	instructions: string;
}

interface EscalationConfig {
	mode: EscalationMode;
	tool: ToolConfig;
	encoder: EncoderConfig;
	/** After an escalated run, start the next N requests on the capable model */
	stickyCapableRequests: number;
}

interface RouterConfig {
	enabled: boolean;
	cheap: TierModel[];
	capable: TierModel[];
	escalation: EscalationConfig;
	/** Requests with image attachments skip the cheap model (often no vision) */
	imagesForceCapable: boolean;
	/** Providers hidden from the tier pickers (e.g. broken or unwanted auth) */
	excludeProviders: string[];
	bigPrefix: string;
	smallPrefix: string;
	notify: boolean;
}

const DEFAULT_INSTRUCTIONS =
	"The agent currently working on this task with a cheap model will fail to complete it.";

const TOOL_DESCRIPTION =
	"Switch the rest of this task to a stronger model. Call this when the task " +
	"needs reasoning, knowledge, or multi-file work beyond what you can do " +
	"reliably — not for work you can complete yourself. Also call it when you " +
	"have been working on a task and, after verifying your solution (tests, " +
	"builds, runtime checks), it turns out wrong or buggy and the fix is not a " +
	"trivial correction.";

/** Injected into the system prompt when a run starts on the cheap tier: what
 * the tool is, when to call it, and what happens after. */
const PROMPT_HINT =
	"\n\nYou are running on a fast, low-cost model. You have an `escalate` tool: " +
	TOOL_DESCRIPTION +
	" When you call it, the rest of this task continues on a stronger model " +
	"automatically — you keep your progress and context. Do not call it for " +
	"work you can complete yourself. If your verified solution is wrong or " +
	"buggy, escalate instead of patching blindly.";

const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	cheap: [],
	capable: [],
	escalation: {
		mode: "tool",
		tool: { promptHint: true },
		encoder: {
			enabled: false,
			url: "http://127.0.0.1:9731",
			timeoutMs: 2000,
			threshold: 0.75,
			minConfidence: 0.4,
			checkEvery: 1,
			maxChecks: 8,
			instructions: DEFAULT_INSTRUCTIONS,
		},
		stickyCapableRequests: 0,
	},
	imagesForceCapable: true,
	excludeProviders: [],
	bigPrefix: "!big",
	smallPrefix: "!small",
	notify: true,
};

function loadConfig(cwd: string): RouterConfig {
	const paths = [join(getAgentDir(), "model-router.json"), join(cwd, CONFIG_DIR_NAME, "model-router.json")];
	let config: RouterConfig = {
		...DEFAULT_CONFIG,
		escalation: {
			...DEFAULT_CONFIG.escalation,
			tool: { ...DEFAULT_CONFIG.escalation.tool },
			encoder: { ...DEFAULT_CONFIG.escalation.encoder },
		},
	};
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RouterConfig>;
			if (parsed.escalation) {
				const escalation = parsed.escalation as Partial<EscalationConfig>;
				parsed.escalation = {
					...config.escalation,
					...escalation,
					tool: { ...config.escalation.tool, ...(escalation.tool ?? {}) },
					encoder: { ...config.escalation.encoder, ...(escalation.encoder ?? {}) },
				};
			}
			config = { ...config, ...parsed };
		} catch (err) {
			console.error(`[model-router] Failed to parse ${path}: ${err}`);
		}
	}
	return config;
}

/** Where tier changes are written: the project config if one exists (it wins
 * over global per-key), otherwise the global config. */
function configFilePath(cwd: string): string {
	const projectPath = join(cwd, CONFIG_DIR_NAME, "model-router.json");
	return existsSync(projectPath) ? projectPath : join(getAgentDir(), "model-router.json");
}

function serializeConfig(config: RouterConfig): string {
	return JSON.stringify(
		{
			enabled: config.enabled,
			cheap: config.cheap,
			capable: config.capable,
			escalation: config.escalation,
			imagesForceCapable: config.imagesForceCapable,
			excludeProviders: config.excludeProviders,
			bigPrefix: config.bigPrefix,
			smallPrefix: config.smallPrefix,
			notify: config.notify,
		},
		null,
		"\t",
	) + "\n";
}

function modelKey(m: { provider: string; model: string }): string {
	return `${m.provider}/${m.model}`;
}

function isSameModel(
	current: { provider: string; id?: string } | undefined,
	target: { provider: string; model: string },
): boolean {
	return !!current && current.provider === target.provider && current.id === target.model;
}

function resolveApiKey(key: string | undefined): string | undefined {
	if (!key) return undefined;
	if (key.startsWith("$")) return process.env[key.slice(1)];
	return key;
}

// --- one run's rolling state -------------------------------------------------

interface ToolEvent {
	tool: string;
	input: string;
	isError: boolean;
	output: string;
}

interface RunState {
	active: boolean;
	escalated: boolean;
	reason: string;
	turns: number;
	checks: number;
	toolEvents: ToolEvent[];
	taskBrief: string;
}

let run: RunState = {
	active: false,
	escalated: false,
	reason: "",
	turns: 0,
	checks: 0,
	toolEvents: [],
	taskBrief: "",
};

// --- the extension -----------------------------------------------------------

export default function modelRouter(pi: ExtensionAPI) {
	let config: RouterConfig = { ...DEFAULT_CONFIG };
	let routingEnabled = true; // /router on|off (persisted via session entries)
	let manualPin = false; // user picked a model manually; auto-routing paused
	let pinnedTier: Tier | null = null; // one-shot pin from !big/!small
	let stickyRemaining = 0;
	let suppressModelSelect = false;
	let lastStatus: string | undefined;

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI && config.notify) ctx.ui.notify(message, level);
	}

	function updateStatus(ctx: ExtensionContext, suffix?: string) {
		if (!ctx.hasUI) return;
		if (!routingEnabled) ctx.ui.setStatus("router", "router: off");
		else if (manualPin) ctx.ui.setStatus("router", "router: paused");
		else ctx.ui.setStatus("router", `router: ${suffix ?? lastStatus ?? "cheap start"}`);
	}

	/** Switch to the first available/authenticated model of a tier. */
	async function applyTierModel(ctx: ExtensionContext, tier: Tier): Promise<TierModel | null> {
		const candidates = tier === "capable" ? config.capable : config.cheap;
		for (const candidate of candidates) {
			const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!model) continue;
			if (isSameModel(ctx.model, candidate)) return candidate;
			suppressModelSelect = true;
			let ok = false;
			try {
				ok = await pi.setModel(model);
				if (ok && candidate.thinkingLevel) pi.setThinkingLevel(candidate.thinkingLevel);
			} finally {
				suppressModelSelect = false;
			}
			if (ok) return candidate;
		}
		return null;
	}

	/** Escalate the current run to the capable model. */
	async function escalate(piApi: ExtensionAPI, ctx: ExtensionContext, reason: string): Promise<boolean> {
		if (run.escalated) return true;
		const applied = await applyTierModel(ctx, "capable");
		if (!applied) {
			notify(ctx, `model-router: no available/authenticated capable model to escalate to`, "warning");
			return false;
		}
		run.escalated = true;
		run.reason = reason;
		if (config.escalation.stickyCapableRequests > 0) stickyRemaining = config.escalation.stickyCapableRequests;
		lastStatus = `escalated(${reason})`;
		updateStatus(ctx);
		notify(ctx, `escalated → ${modelKey(applied)} [${reason}]`);
		return true;
	}

	function setToolEnabled(enabled: boolean) {
		const active = pi.getActiveTools();
		const has = active.includes("escalate");
		if (enabled && !has) pi.setActiveTools([...active, "escalate"]);
		if (!enabled && has) pi.setActiveTools(active.filter((t) => t !== "escalate"));
	}

	function toolModeActive(): boolean {
		return config.escalation.mode === "tool" || config.escalation.mode === "both";
	}

	function encoderModeActive(): boolean {
		return (
			(config.escalation.mode === "encoder" || config.escalation.mode === "both") &&
			config.escalation.encoder.enabled
		);
	}

	// --- the escalate tool ------------------------------------------------------

	pi.registerTool({
		name: "escalate",
		label: "Escalate",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			reason: Type.Optional(
				Type.String({ description: "One line: what specifically is beyond you" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!toolModeActive()) {
				return {
					content: [{ type: "text", text: "Tool escalation is disabled (encoder mode)." }],
					details: { escalated: false },
				};
			}
			const reason = `tool: ${(params.reason ?? "model request").slice(0, 120)}`;
			const ok = await escalate(pi, ctx, reason);
			return {
				content: [
					{
						type: "text",
						text: ok
							? "Escalated. Continue with the task — your next turn runs on the stronger model."
							: "Escalation failed (no capable model available). Continue with the task yourself.",
					},
				],
				details: { escalated: ok },
			};
		},
	});

	// --- encoder: ask laya whether this run is failing --------------------------

	function encoderState(): Record<string, unknown> {
		const tools = run.toolEvents.map((e) => `${e.tool}: ${e.input}`.slice(0, 70));
		const unique = Array.from(new Set(tools));
		const repeated = tools.length > 1 ? 1 - unique.length / tools.length : 0;
		return {
			task_brief: run.taskBrief.slice(0, 260),
			turns_seen: run.turns,
			tool_calls: unique.slice(0, 8),
			n_failed_tools: run.toolEvents.filter((e) => e.isError).length,
			repeated_tool_fraction: Math.round(repeated * 100) / 100,
			last_tool: tools.length ? tools[tools.length - 1] : "",
			last_output_tail: (run.toolEvents.at(-1)?.output ?? "").slice(-240),
		};
	}

	async function encoderCheck(ctx: ExtensionContext): Promise<void> {
		const encoder = config.escalation.encoder;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), encoder.timeoutMs);
		const onUserAbort = () => controller.abort();
		ctx.signal?.addEventListener("abort", onUserAbort);
		try {
			const headers: Record<string, string> = { "content-type": "application/json" };
			const apiKey = resolveApiKey(encoder.apiKey);
			if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
			const body = {
				state: encoderState(),
				questions: { escalate: { type: "noul", instructions: encoder.instructions } },
			};
			const res = await fetch(`${encoder.url.replace(/\/$/, "")}/v1/systemone`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) return;
			const data = (await res.json()) as {
				answers?: { escalate?: { type?: string; noul?: number; answer_confidence?: number } };
			};
			const answer = data.answers?.escalate;
			if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") return;
			const confidence = typeof answer.answer_confidence === "number" ? answer.answer_confidence : 1;
			if (confidence < encoder.minConfidence) return;
			if (answer.noul >= encoder.threshold) {
				await escalate(pi, ctx, `encoder p=${answer.noul.toFixed(2)}`);
			}
		} catch {
			/* encoder unavailable: never block the run */
		} finally {
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onUserAbort);
		}
	}

	// --- events ------------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const markers: Array<[string, Tier]> = [
			[config.bigPrefix, "capable"],
			[config.smallPrefix, "cheap"],
		];
		for (const [prefix, tier] of markers) {
			if (!prefix) continue;
			if (event.text === prefix || event.text.startsWith(prefix + " ")) {
				pinnedTier = tier;
				const rest = event.text === prefix ? "" : event.text.slice(prefix.length + 1);
				if (!rest.trim()) {
					notify(ctx, `Next request starts on the ${tier} model.`, "info");
					return { action: "handled" };
				}
				return { action: "transform", text: rest };
			}
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		run = {
			active: true,
			escalated: false,
			reason: "",
			turns: 0,
			checks: 0,
			toolEvents: [],
			taskBrief: event.prompt.slice(0, 400),
		};

		if (!routingEnabled || manualPin) {
			lastStatus = manualPin ? "paused" : "off";
			updateStatus(ctx);
			return;
		}

		// Choose the starting tier: pin > sticky > images > cheap.
		let start: Tier = "cheap";
		if (pinnedTier) {
			start = pinnedTier;
			pinnedTier = null;
		} else if (stickyRemaining > 0) {
			start = "capable";
			stickyRemaining -= 1;
		} else if (config.imagesForceCapable && (event.images?.length ?? 0) > 0) {
			start = "capable";
		}

		const applied = await applyTierModel(ctx, start);
		lastStatus = applied ? `${start}:${applied.model}` : "no models";
		updateStatus(ctx);

		// The tool hint only makes sense when we actually started cheap.
		if (applied && start === "cheap" && toolModeActive() && config.escalation.tool.promptHint) {
			return { systemPrompt: event.systemPrompt + PROMPT_HINT };
		}
	});

	pi.on("tool_result", async (event) => {
		if (!run.active || run.escalated) return;
		const text = (event.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ");
		run.toolEvents.push({
			tool: event.toolName,
			input: JSON.stringify(event.input ?? {}).slice(0, 80),
			isError: !!event.isError,
			output: text,
		});
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!run.active || run.escalated || !encoderModeActive()) return;
		run.turns += 1;
		const encoder = config.escalation.encoder;
		if (run.turns % encoder.checkEvery !== 0) return;
		if (run.checks >= encoder.maxChecks) return;
		if (run.toolEvents.length === 0) return; // nothing observable yet
		run.checks += 1;
		await encoderCheck(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (suppressModelSelect) return; // our own switch
		if (event.source === "restore") return;
		if (!routingEnabled || manualPin) return;
		manualPin = true;
		lastStatus = "paused";
		notify(
			ctx,
			`model-router paused: you selected ${event.model.provider}/${event.model.id}. Run /router auto to re-enable.`,
			"info",
		);
		updateStatus(ctx);
	});

	/** Pick or set the model for a tier, and persist it to the config file. */
	async function chooseTier(ctx: ExtensionContext, tier: Tier, explicit?: string): Promise<void> {
		try {
			await chooseTierUnsafe(ctx, tier, explicit);
		} catch (err) {
			// Never let a provider's auth blow up the session: an expired OAuth
			// token rejects deep inside the registry.
			notify(ctx, `Could not set the ${tier} tier: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	/** Configured providers, without resolving credentials (sync and safe). */
	function providerHasAuth(ctx: ExtensionContext, provider: string): boolean {
		try {
			const status = ctx.modelRegistry.getProviderAuthStatus?.(provider);
			return status ? !!status.configured : true;
		} catch {
			return false; // a provider whose status check throws is skipped, not fatal
		}
	}

	/**
	 * Model picker: type-to-filter over the catalogue (substring match), with a
	 * free-text fallback row so any model id can be typed directly. The built-in
	 * ui.select renders every row, so a catalogue-sized list floods the terminal
	 * and stops taking input — this is the same windowed SelectList pi's own
	 * pickers use, with the query handling done here (SelectList only filters
	 * on demand and matches by prefix).
	 */
	async function pickModel(ctx: ExtensionContext, title: string, labels: string[]): Promise<string | null> {
		if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
			return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const all: SelectItem[] = labels.map((label) => ({ value: label, label }));
				let query = "";

				const container = new Container();
				const queryText = new Text("");
				const listSlot = new Container();
				const themeCallbacks = {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				};

				const applyQuery = () => {
					const q = query.trim().toLowerCase();
					let filtered = q ? all.filter((item) => item.label.toLowerCase().includes(q)) : all.slice();
					if (q && filtered.length === 0) {
						// Free text: let the user commit an id that is not in the list;
						// chooseTier validates it against the registry afterwards.
						filtered = [{ value: query.trim(), label: `✎ use "${query.trim()}"` }];
					}
					listSlot.clear();
					const selectList = new SelectList(filtered, Math.min(filtered.length, 12) || 1, themeCallbacks);
					selectList.onSelect = (item) => done(item.value ?? null);
					selectList.onCancel = () => done(null);
					listSlot.addChild(selectList);
					queryText.setText(
						theme.fg("dim", `filter: ${query}${query ? "▌" : "…"}  (${filtered.length}/${all.length})`),
					);
				};

				applyQuery();
				container.addChild(new Text(theme.fg("accent", theme.bold(title))));
				container.addChild(new Text(""));
				container.addChild(queryText);
				container.addChild(new Text(""));
				container.addChild(listSlot);
				container.addChild(new Text(""));
				container.addChild(new Text(theme.fg("dim", "type to filter · ↑↓ select · enter confirm · esc cancel")));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						if (data === "\x7f" || data === "\b") {
							query = query.slice(0, -1);
							applyQuery();
						} else if (data.length === 1 && data >= " " && data !== "\x7f") {
							query += data;
							applyQuery();
						} else {
							listSlot.children.at(-1)?.handleInput?.(data);
						}
						tui.requestRender();
					},
				};
			});
		}
		return (await ctx.ui.select(title, labels)) ?? null;
	}

	async function chooseTierUnsafe(ctx: ExtensionContext, tier: Tier, explicit?: string): Promise<void> {
		let provider: string | undefined;
		let modelId: string | undefined;

		if (explicit) {
			const slash = explicit.indexOf("/");
			if (slash <= 0) {
				notify(ctx, `Use provider/model, e.g. /router ${tier} anthropic/claude-sonnet-5`, "error");
				return;
			}
			provider = explicit.slice(0, slash);
			modelId = explicit.slice(slash + 1);
			if (!ctx.modelRegistry.find(provider, modelId)) {
				notify(ctx, `Unknown model ${explicit} — check \`pi --list-models\``, "error");
				return;
			}
		} else {
			const current = (tier === "cheap" ? config.cheap : config.capable)[0];
			const currentKey = current ? modelKey(current) : "";
			const keys = Array.from(
				new Set(
					ctx.modelRegistry
						.getAvailable()
						.filter((m) => providerHasAuth(ctx, m.provider))
						.filter((m) => !config.excludeProviders.some((p) => p.toLowerCase() === m.provider.toLowerCase()))
						.map((m) => `${m.provider}/${m.id}`),
				),
			).sort();
			if (keys.length === 0) {
				notify(ctx, "No models with configured auth found", "error");
				return;
			}
			const labels = keys.map((key) => (key === currentKey ? `${key}  (current)` : key));
			const choice = await pickModel(ctx, `Model for the ${tier} tier:`, labels);
			if (!choice) return;
			const key = choice.replace(/  \(current\)$/, "");
			provider = key.slice(0, key.indexOf("/"));
			modelId = key.slice(key.indexOf("/") + 1);
		}

		const previous = (tier === "cheap" ? config.cheap : config.capable)[0];
		const entry: TierModel = {
			provider,
			model: modelId,
			thinkingLevel: previous?.thinkingLevel ?? (tier === "cheap" ? "low" : "high"),
		};
		if (tier === "cheap") config.cheap = [entry];
		else config.capable = [entry];

		try {
			const path = configFilePath(ctx.cwd);
			writeFileSync(path, serializeConfig(config));
			notify(ctx, `${tier} tier → ${modelKey(entry)} (saved to ${path})`);
		} catch (err) {
			notify(ctx, `${tier} tier → ${modelKey(entry)} (could not save config: ${err})`, "warning");
		}
		updateStatus(ctx, `${tier}:${entry.model}`);
	}

	// --- /router command -----------------------------------------------------------

	pi.registerCommand("router", {
		description: "Model router: status, on/off, auto, mode tool|encoder|both, cheap|capable, big/small",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const [cmdRaw, ...restParts] = raw.split(/\s+/);
			const arg = (cmdRaw ?? "").toLowerCase();
			const rest = restParts.join(" "); // preserve case for model ids
			switch (arg) {
				case "on":
					routingEnabled = true;
					notify(ctx, "model-router enabled", "info");
					break;
				case "off":
					routingEnabled = false;
					notify(ctx, "model-router disabled", "info");
					break;
				case "auto":
					routingEnabled = true;
					manualPin = false;
					pinnedTier = null;
					stickyRemaining = 0;
					notify(ctx, "model-router: auto (cheap start + escalation) active", "info");
					break;
				case "tool":
				case "encoder":
				case "both":
					config.escalation.mode = arg as EscalationMode;
					setToolEnabled(toolModeActive());
					notify(ctx, `model-router: escalation mode = ${arg}`, "info");
					break;
				case "cheap":
				case "capable":
					await chooseTier(ctx, arg as Tier, rest || undefined);
					break;
				case "big":
				case "small":
					pinnedTier = arg === "big" ? "capable" : "cheap";
					notify(ctx, `Next request starts on the ${pinnedTier} model`, "info");
					break;
				default: {
					const lines = [
						`enabled: ${routingEnabled}${manualPin ? " (paused — manual model selection)" : ""}`,
						`cheap: ${config.cheap.map(modelKey).join(", ") || "(none)"}`,
						`capable: ${config.capable.map(modelKey).join(", ") || "(none)"}`,
						`escalation mode: ${config.escalation.mode}` +
							(toolModeActive() ? " (escalate tool active)" : "") +
							(encoderModeActive() ? ` (encoder @ ${config.escalation.encoder.url}, threshold ${config.escalation.encoder.threshold})` : ""),
						`pending one-shot: ${pinnedTier ?? "none"} | sticky: ${stickyRemaining}`,
						`current run: ${run.active ? `${run.turns} turns, ${run.checks} encoder checks${run.escalated ? `, ESCALATED (${run.reason})` : ""}` : "inactive"}`,
						"set a tier: /router cheap [provider/model] | /router capable [provider/model]",
					];
					notify(ctx, `model-router\n${lines.join("\n")}`, "info");
				}
			}
			updateStatus(ctx);
		},
	});

	// --- session lifecycle ------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);

		// Providers whose credentials cannot even be inspected (expired OAuth,
		// for instance) must not stop the session from wiring up.
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "router-state")
			.pop() as { data?: { enabled?: boolean } } | undefined;
		if (stateEntry?.data && typeof stateEntry.data.enabled === "boolean") {
			routingEnabled = stateEntry.data.enabled;
		}

		manualPin = false;
		pinnedTier = null;
		stickyRemaining = 0;
		lastStatus = undefined;
		setToolEnabled(toolModeActive());

		updateStatus(ctx);
		if (ctx.hasUI && (config.cheap.length === 0 || config.capable.length === 0)) {
			ctx.ui.notify(
				"model-router: set 'cheap' and 'capable' model lists in ~/.pi/agent/model-router.json (see README)",
				"warning",
			);
		}
	});

	pi.on("turn_start", async () => {
		pi.appendEntry("router-state", { enabled: routingEnabled });
	});
}
