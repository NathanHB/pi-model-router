/**
 * Model Router extension — escalation architecture.
 *
 * The user defines a CHEAP and a CAPABLE model. Every request starts on the
 * cheap model. Escalation to the capable model happens *during* the run, when
 * the cheap model calls its `escalate` tool ("this needs a stronger model").
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

type Tier = "cheap" | "capable";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface TierModel {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

interface ToolConfig {
	/** Append a hint to the system prompt telling the model the tool exists */
	promptHint: boolean;
}

interface EscalationConfig {
	tool: ToolConfig;
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
		tool: { promptHint: true },
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
		escalation: { ...DEFAULT_CONFIG.escalation, tool: { ...DEFAULT_CONFIG.escalation.tool } },
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

interface RunState {
	active: boolean;
	escalated: boolean;
	reason: string;
	turns: number;
}

let run: RunState = { active: false, escalated: false, reason: "", turns: 0 };

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
		run = { active: true, escalated: false, reason: "", turns: 0 };

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
		if (applied && start === "cheap" && config.escalation.tool.promptHint) {
			return { systemPrompt: event.systemPrompt + PROMPT_HINT };
		}
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
			const choice = (await ctx.ui.select(`Model for the ${tier} tier:`, labels)) ?? null;
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
		description: "Model router: status, on/off, auto, cheap|capable, big/small",
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
						`escalation: escalate tool ${config.escalation.tool.promptHint ? "with" : "without"} prompt hint`,
						`pending one-shot: ${pinnedTier ?? "none"} | sticky: ${stickyRemaining}`,
						`current run: ${run.active ? `${run.turns} turns${run.escalated ? `, ESCALATED (${run.reason})` : ""}` : "inactive"}`,
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
		setToolEnabled(true);

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
