/**
 * Model Router extension
 *
 * Routes each request to a "capable" or "cheap" model:
 *  1. One-shot markers (`!big <msg>` / `!small <msg>`) or `/router big|small`
 *  2. A small decision model — convaiinnovations/laya served via `laya-serve`
 *     (POST /v1/systemone) — classifies the prompt in ~35 ms
 *  3. Heuristic fallback (keywords / length / images) when the decision
 *     model is unreachable or returns low confidence
 *
 * If the user manually picks a model (/model, Ctrl+P), auto-routing pauses
 * until `/router auto` is run. `/router on|off` toggles routing entirely,
 * `/router decision` toggles the laya decision step.
 *
 * Config files (merged per-key, project wins):
 *  - ~/.pi/agent/model-router.json       (global)
 *  - <cwd>/.pi/model-router.json         (project)
 *
 * See model-router.example.json and README.md in this directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

type Tier = "capable" | "cheap";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface TierModel {
	/** Provider id, e.g. "anthropic" */
	provider: string;
	/** Model id, e.g. "claude-haiku-4-5" */
	model: string;
	/** Optional thinking level applied when this model is routed in */
	thinkingLevel?: ThinkingLevel;
}

interface DecisionConfig {
	/** Use the laya decision model for routing (falls back to heuristics when down) */
	enabled: boolean;
	/** Question type sent to laya: "score" (3 capability levels, default) or "choice" (capable vs cheap) */
	mode: "score" | "choice";
	/** Base URL of a running `laya-serve` instance */
	url: string;
	/** Bearer token; "$VAR" resolves from the environment. Omit for a local unauthenticated server. */
	apiKey?: string;
	/** Give up on the decision call after this many ms and fall back to heuristics */
	timeoutMs: number;
	/** Below this the answer is not trusted enough to escalate, so the request goes cheap */
	minConfidence: number;
	/**
	 * How much capability a request must show to get the capable tier:
	 * the normalized score (score mode) or P(capable) (choice mode).
	 * Raise it to send more work to the cheap model.
	 */
	capableThreshold: number;
	/** How much of the prompt to send to the decision model */
	stateChars: number;
	/** score mode: capability levels, lowest first */
	scoreCriteria: string[];
	/** choice mode: options keyed "capable"/"cheap" */
	criteria?: Record<string, string>;
	/** Optional override of the instructions sent to laya */
	instructions?: string;
}

interface RouterConfig {
	enabled: boolean;
	/** Tier used when no heuristic matches */
	defaultTier: Tier;
	/** Models tried in order for the "capable" tier */
	capable: TierModel[];
	/** Models tried in order for the "cheap" tier */
	cheap: TierModel[];
	/** Whole-word, case-insensitive keywords that force the capable tier (heuristic fallback) */
	capableKeywords: string[];
	/** Whole-word, case-insensitive keywords that force the cheap tier (heuristic fallback) */
	cheapKeywords: string[];
	/** Prompts at least this many characters long are routed capable (heuristic fallback) */
	promptLengthThreshold: number;
	/** Requests with image attachments are routed capable */
	imagesForceCapable: boolean;
	/** After a capable request, stay capable for N more requests (0 = off) */
	stickyCapableRequests: number;
	/** One-shot prefix markers */
	bigPrefix: string;
	smallPrefix: string;
	/** Show a notification whenever routing switches the model */
	notify: boolean;
	/** The laya decision model configuration */
	decision: DecisionConfig;
}

const DEFAULT_SCORE_INSTRUCTIONS = "How much capability does this request need from a coding assistant?";

/** score mode: routine work sits at "low" so it never reaches the capable threshold */
const DEFAULT_SCORE_CRITERIA = [
	"low: a question, a lookup of email/messages/notifications/issues/docs, a summary, or a tiny single-file edit (rename, typo, formatting, version bump, log line)",
	"medium: a contained change or bug fix in one file, or explaining a snippet",
	"high: multi-file work, open-ended investigation, design, migration, or security review",
];

const DEFAULT_CHOICE_INSTRUCTIONS =
	"Which model tier should answer this coding assistant request? Prefer the cheap tier. " +
	"Choose capable only when the task genuinely needs deep reasoning or spans many files or systems.";

const DEFAULT_CHOICE_CRITERIA: Record<string, string> = {
	capable:
		"multi-file or architectural changes; deep debugging where the cause is unknown; " +
		"security-sensitive work; performance or scalability tuning; migrations; designing a new " +
		"subsystem; reasoning across several components",
	cheap:
		"small or single-file edits (renaming, small bug fixes, one function, config tweaks, " +
		"typos, formatting); looking things up (emails, notifications, issues, logs, docs); " +
		"explaining a snippet; simple questions; chit-chat",
};

const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	defaultTier: "cheap",
	capable: [],
	cheap: [],
	capableKeywords: ["architect", "architecture", "redesign", "concurrency", "migration", "migrate", "root cause"],
	cheapKeywords: [
		"email",
		"inbox",
		"gmail",
		"notification",
		"notifications",
		"typo",
		"rename",
		"formatting",
		"lint",
		"bump",
		"summarize",
		"summary",
		"explain",
		"look up",
		"lookup",
		"what's in",
		"draft a reply",
	],
	promptLengthThreshold: 3000,
	imagesForceCapable: true,
	stickyCapableRequests: 0,
	bigPrefix: "!big",
	smallPrefix: "!small",
	notify: true,
	decision: {
		enabled: true,
		mode: "score",
		url: "http://127.0.0.1:9731",
		timeoutMs: 2000,
		minConfidence: 0.4,
		capableThreshold: 0.6,
		stateChars: 4000,
		scoreCriteria: DEFAULT_SCORE_CRITERIA,
	},
};

function loadConfig(cwd: string): RouterConfig {
	const paths = [join(getAgentDir(), "model-router.json"), join(cwd, CONFIG_DIR_NAME, "model-router.json")];
	let config: RouterConfig = { ...DEFAULT_CONFIG, decision: { ...DEFAULT_CONFIG.decision } };
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RouterConfig>;
			if (parsed.decision) {
				parsed.decision = { ...config.decision, ...parsed.decision };
			}
			config = { ...config, ...parsed };
		} catch (err) {
			console.error(`[model-router] Failed to parse ${path}: ${err}`);
		}
	}
	return config;
}

function keywordRegexes(keywords: string[]): RegExp[] {
	return keywords
		.filter((k) => k.trim().length > 0)
		.map((k) => new RegExp(`\\b${k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
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

/** Resolve "$VAR" API-key references from the environment. */
function resolveApiKey(key: string | undefined): string | undefined {
	if (!key) return undefined;
	if (key.startsWith("$")) return process.env[key.slice(1)];
	return key;
}

interface LayaAnswer {
	type?: string;
	choice?: string;
	/** score answers: expected level, 0..levels-1 */
	score?: number;
	/** score answers: level index -> label */
	legend?: Record<string, string>;
	/** Normalized entropy concentration — NOT the probability of the answer; do not gate on this */
	confidence?: number;
	/** Calibrated probability mass on the reported answer (max(p)) */
	answer_confidence?: number;
	probabilities?: Record<string, number>;
}

interface LayaDecision {
	/** Capability signal normalized to 0..1: score / (levels-1), or P(capable) in choice mode */
	capableScore: number;
	/** Calibrated confidence in the reported answer */
	confidence: number;
}

/** Number of options/levels reported by a laya answer. */
function levelCount(answer: LayaAnswer): number {
	const keys = answer.legend
		? Object.keys(answer.legend)
		: answer.probabilities
			? Object.keys(answer.probabilities)
			: [];
	return keys.length || 1;
}

/**
 * Ask the laya decision model (convaiinnovations/laya via `laya-serve`) how
 * much capability this request needs. Returns a normalized capability score
 * (0 = trivial, 1 = maximum) plus the calibrated answer confidence, or null
 * when the decision model is unavailable or returned nothing usable.
 */
async function layaDecide(
	prompt: string,
	hasImages: boolean,
	ctx: ExtensionContext,
	config: RouterConfig,
): Promise<LayaDecision | null> {
	const decision = config.decision;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), decision.timeoutMs);
	const onUserAbort = () => controller.abort();
	ctx.signal?.addEventListener("abort", onUserAbort);
	try {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const apiKey = resolveApiKey(decision.apiKey);
		if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

		const mode = decision.mode;
		const question =
			mode === "score"
				? {
						type: "score",
						instructions: decision.instructions ?? DEFAULT_SCORE_INSTRUCTIONS,
						criteria: decision.scoreCriteria ?? DEFAULT_SCORE_CRITERIA,
					}
				: {
						type: "choice",
						instructions: decision.instructions ?? DEFAULT_CHOICE_INSTRUCTIONS,
						criteria: decision.criteria ?? DEFAULT_CHOICE_CRITERIA,
					};

		const body = {
			state: {
				body: prompt.slice(0, decision.stateChars),
				prompt_chars: prompt.length,
				image_attachments: hasImages ? 1 : 0,
			},
			questions: { tier: question },
		};

		const res = await fetch(`${decision.url.replace(/\/$/, "")}/v1/systemone`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) return null;

		const data = (await res.json()) as { answers?: Record<string, LayaAnswer> };
		const answer = data.answers?.["tier"];
		if (!answer) return null;

		if (mode === "score") {
			if (answer.type !== "score" || typeof answer.score !== "number") return null;
			const maxLevel = Math.max(1, levelCount(answer) - 1);
			return {
				capableScore: answer.score / maxLevel,
				confidence: answer.answer_confidence ?? 1,
			};
		}

		if (answer.type !== "choice") return null;
		const tier = answer.choice;
		if (tier !== "capable" && tier !== "cheap") return null;

		// Gate on the calibrated probability of the chosen answer. `confidence`
		// is an entropy score, `answer_confidence` is the calibrated max(p).
		const confidence =
			answer.answer_confidence ??
			(typeof answer.probabilities?.[tier] === "number" ? answer.probabilities[tier] : 1);
		const capableScore =
			typeof answer.probabilities?.["capable"] === "number"
				? answer.probabilities["capable"]
				: tier === "capable"
					? confidence
					: 1 - confidence;

		return { capableScore, confidence };
	} catch {
		return null; // server down, timeout, malformed response, user abort
	} finally {
		clearTimeout(timer);
		ctx.signal?.removeEventListener("abort", onUserAbort);
	}
}

interface Decision {
	tier: Tier;
	/** Human-readable source of the decision, e.g. "laya 0.91" or "heuristic" */
	source: string;
}

export default function modelRouter(pi: ExtensionAPI) {
	let config: RouterConfig = { ...DEFAULT_CONFIG, decision: { ...DEFAULT_CONFIG.decision } };

	// Routing state
	let routingEnabled = true; // /router on|off (persisted via session entries)
	let manualPin = false; // user picked a model manually; auto-routing paused
	let pinnedTier: Tier | null = null; // one-shot override from !big/!small or /router big|small
	let stickyRemaining = 0;
	let suppressModelSelect = false; // true while we switch models ourselves
	let lastDecision: string | undefined; // status text of the last routing decision
	let warnedNoModels = false;
	let warnedLayaDown = false;

	function hasTierModels(): boolean {
		return config.capable.length > 0 && config.cheap.length > 0;
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI && config.notify) ctx.ui.notify(message, level);
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!routingEnabled) {
			ctx.ui.setStatus("router", "router: off");
		} else if (manualPin) {
			ctx.ui.setStatus("router", "router: paused");
		} else {
			ctx.ui.setStatus("router", `router: ${lastDecision ?? "auto"}`);
		}
	}

	/** Switch to the first available/authenticated model of a tier. Returns the applied model, or null. */
	async function applyTierModel(ctx: ExtensionContext, tier: Tier): Promise<TierModel | null> {
		const candidates = tier === "capable" ? config.capable : config.cheap;
		for (const candidate of candidates) {
			const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!model) continue;

			// Already on this model: nothing to do (keep the user's thinking level).
			if (isSameModel(ctx.model, candidate)) {
				return candidate;
			}

			suppressModelSelect = true;
			let ok = false;
			try {
				ok = await pi.setModel(model);
				if (ok && candidate.thinkingLevel) {
					pi.setThinkingLevel(candidate.thinkingLevel);
				}
			} finally {
				suppressModelSelect = false;
			}
			if (ok) return candidate;
		}
		return null;
	}

	/** Route the current request to the given tier and update UI state. */
	async function routeTo(ctx: ExtensionContext, decision: Decision): Promise<void> {
		if (!hasTierModels()) {
			if (!warnedNoModels) {
				warnedNoModels = true;
				notify(
					ctx,
					"model-router: no models configured. Add 'capable' and 'cheap' lists to ~/.pi/agent/model-router.json",
					"warning",
				);
			}
			return;
		}

		const previous = ctx.model;
		const applied = await applyTierModel(ctx, decision.tier);
		if (!applied) {
			notify(ctx, `model-router: no available/authenticated ${decision.tier} model found`, "warning");
			lastDecision = `${decision.tier}? (unavailable)`;
			updateStatus(ctx);
			return;
		}

		if (decision.tier === "capable" && stickyRemaining === 0 && config.stickyCapableRequests > 0) {
			stickyRemaining = config.stickyCapableRequests;
		}

		lastDecision = `${decision.tier}:${applied.model} [${decision.source}]`;
		updateStatus(ctx);

		// Only notify when the model actually changed for this request.
		if (!isSameModel(previous, applied)) {
			notify(ctx, `router → ${decision.tier} (${modelKey(applied)}) [${decision.source}]`);
		}
	}

	/** Heuristic fallback used when the decision model is unavailable or unconfident. */
	function heuristicDecide(prompt: string, hasImages: boolean): Decision {
		if (config.imagesForceCapable && hasImages) return { tier: "capable", source: "heuristic:images" };
		if (prompt.length >= config.promptLengthThreshold) return { tier: "capable", source: "heuristic:length" };
		if (keywordRegexes(config.capableKeywords).some((re) => re.test(prompt))) {
			return { tier: "capable", source: "heuristic:keyword" };
		}
		if (keywordRegexes(config.cheapKeywords).some((re) => re.test(prompt))) {
			return { tier: "cheap", source: "heuristic:keyword" };
		}
		return { tier: config.defaultTier, source: "heuristic:default" };
	}

	/**
	 * Decide which tier this request needs, or null if the router should not
	 * touch the model at all (disabled or paused by manual selection).
	 */
	async function decideTier(ctx: ExtensionContext, prompt: string, hasImages: boolean): Promise<Decision | null> {
		if (!routingEnabled || manualPin) return null;

		// Sticky continuation: recent capable request → stay capable.
		if (stickyRemaining > 0) {
			stickyRemaining--;
			return { tier: "capable", source: "sticky" };
		}

		// Ask the laya decision model.
		if (config.decision.enabled) {
			const laya = await layaDecide(prompt, hasImages, ctx, config);
			if (laya) {
				warnedLayaDown = false;
				// An uncertain answer never escalates: ambiguity goes to the cheap model.
				if (laya.confidence < config.decision.minConfidence) {
					return { tier: "cheap", source: "laya low-conf" };
				}
				return {
					tier: laya.capableScore >= config.decision.capableThreshold ? "capable" : "cheap",
					source: `laya ${laya.capableScore.toFixed(2)}`,
				};
			}
			if (!warnedLayaDown) {
				warnedLayaDown = true;
				notify(
					ctx,
					`model-router: decision model at ${config.decision.url} unavailable — using heuristics. Start it with: laya-serve`,
					"warning",
				);
			}
		}

		return heuristicDecide(prompt, hasImages);
	}

	// --- One-shot markers (!big / !small) -----------------------------------

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
					notify(ctx, `Next request will use the ${tier} model. Type your message now.`, "info");
					return { action: "handled" };
				}
				return { action: "transform", text: rest };
			}
		}
		return { action: "continue" };
	});

	// --- The router itself ---------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		// Consume a one-shot pin (!big / !small / /router big|small) if present.
		if (pinnedTier) {
			const tier = pinnedTier;
			pinnedTier = null;
			await routeTo(ctx, { tier, source: "pinned" });
			return;
		}

		const decision = await decideTier(ctx, event.prompt, (event.images?.length ?? 0) > 0);
		if (decision === null) {
			lastDecision = manualPin ? "paused" : "off";
			updateStatus(ctx);
			return;
		}
		await routeTo(ctx, decision);
	});

	// --- Pause when the user picks a model manually ---------------------------

	pi.on("model_select", async (event, ctx) => {
		if (suppressModelSelect) return; // our own switch
		if (event.source === "restore") return;
		if (!routingEnabled || manualPin) return;
		manualPin = true;
		lastDecision = "paused";
		notify(
			ctx,
			`model-router paused: you selected ${event.model.provider}/${event.model.id}. Run /router auto to re-enable.`,
			"info",
		);
		updateStatus(ctx);
	});

	// --- /router command ------------------------------------------------------

	pi.registerCommand("router", {
		description: "Model router: status, on/off, auto, decision toggle, big/small one-shot",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();

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
					notify(ctx, "model-router: auto-routing active", "info");
					break;
				case "decision":
					config.decision.enabled = !config.decision.enabled;
					notify(
						ctx,
						`model-router: laya decision model ${config.decision.enabled ? "enabled" : "disabled (heuristics only)"}`,
						"info",
					);
					break;
				case "big":
				case "small": {
					if (!hasTierModels()) {
						notify(ctx, "model-router: no models configured", "warning");
						break;
					}
					pinnedTier = arg === "big" ? "capable" : "cheap";
					notify(ctx, `Next request will use the ${pinnedTier} model`, "info");
					break;
				}
				case "":
				default: {
					const decision = config.decision;
					const levels =
						decision.mode === "score" ? (decision.scoreCriteria ?? DEFAULT_SCORE_CRITERIA) : [];
					const lines = [
						`enabled: ${routingEnabled}${manualPin ? " (paused — manual model selection)" : ""}`,
						`decision model: ${
							decision.enabled
								? `${decision.url} (laya ${decision.mode}, capable ≥ ${decision.capableThreshold}, conf ≥ ${decision.minConfidence})`
								: "off (heuristics only)"
						}`,
						`pending one-shot: ${pinnedTier ?? "none"}`,
						`default tier: ${config.defaultTier}`,
						`capable: ${config.capable.map(modelKey).join(", ") || "(none)"}`,
						`cheap: ${config.cheap.map(modelKey).join(", ") || "(none)"}`,
						`length threshold: ${config.promptLengthThreshold} chars (fallback)`,
						`capable keywords: ${config.capableKeywords.join(", ") || "(none)"} (fallback)`,
						`sticky capable requests: ${config.stickyCapableRequests}`,
						`markers: "${config.bigPrefix} <msg>" / "${config.smallPrefix} <msg>"`,
						`last decision: ${lastDecision ?? "none yet"}`,
						...(levels.length ? [`score levels: ${levels.join(" | ")}`] : []),
					];
					notify(ctx, `model-router\n${lines.join("\n")}`, "info");
					break;
				}
			}
			updateStatus(ctx);
		},
	});

	// --- Session lifecycle -----------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);

		// Restore persisted state from the session (last entry wins).
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
		lastDecision = undefined;
		warnedNoModels = false;
		warnedLayaDown = false;

		updateStatus(ctx);
		if (ctx.hasUI && !hasTierModels()) {
			ctx.ui.notify(
				"model-router: add 'capable' and 'cheap' model lists to ~/.pi/agent/model-router.json (see extension README)",
				"warning",
			);
		}
	});

	pi.on("turn_start", async () => {
		pi.appendEntry("router-state", { enabled: routingEnabled });
	});
}
