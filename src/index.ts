import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneDefaultConfig, getConfigPaths, loadConfig, saveConfig } from "./config.js";
import { buildClassifierPrompt, CLASSIFIER_SYSTEM_PROMPT, parseClassifierDecision } from "./router.js";
import {
	ROUTER_MODES,
	ROUTE_NAMES,
	type ClassifierDecision,
	type RouteName,
	type RouterConfig,
	type RouterMode,
} from "./types.js";

function modelKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function currentRoute(config: RouterConfig, ctx: ExtensionContext): RouteName | undefined {
	if (!ctx.model) return undefined;
	return ROUTE_NAMES.find((route) => {
		const target = config.models[route];
		return target.provider === ctx.model?.provider && target.model === ctx.model.id;
	});
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const value = part as Record<string, unknown>;
			return value.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function getRecentConversation(ctx: ExtensionContext, prompt: string, messageLimit: number, charLimit: number): string {
	if (messageLimit === 0 || charLimit === 0) return "";
	const chunks: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textFromContent(message.content).trim();
		if (!text || (message.role === "user" && text === prompt.trim())) continue;
		chunks.push(`${message.role}: ${text.slice(0, 2_000)}`);
	}
	return chunks.slice(-messageLimit).join("\n\n").slice(-charLimit);
}

function truncatePrompt(prompt: string, limit: number): string {
	if (prompt.length <= limit) return prompt;
	const marker = "\n\n[... request truncated for routing ...]\n\n";
	const available = Math.max(0, limit - marker.length);
	const headLength = Math.ceil(available * 0.6);
	return `${prompt.slice(0, headLength)}${marker}${prompt.slice(-(available - headLength))}`;
}

function fallbackDecision(route: RouteName, reason: string): ClassifierDecision {
	return {
		route,
		ranking: [route, ...ROUTE_NAMES.filter((candidate) => candidate !== route)],
		confidence: 0,
		reason,
	};
}

export default function modelRouterExtension(pi: ExtensionAPI) {
	let config: RouterConfig = cloneDefaultConfig();
	let pinnedRoute: RouteName | undefined;
	let lastRoute: RouteName | undefined;
	let lastModel: string | undefined;

	pi.registerFlag("router-mode", {
		description: "Model router policy: cost, balance, or intelligence",
		type: "string",
	});
	pi.registerFlag("router-off", {
		description: "Disable automatic model routing",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext) {
		if (!config.enabled) {
			ctx.ui.setStatus("pi-router", "router:off");
			return;
		}
		const route = pinnedRoute ? `pin:${pinnedRoute}` : config.mode;
		const model = lastModel ? ` → ${lastModel}` : "";
		ctx.ui.setStatus("pi-router", `router:${route}${model}`);
	}

	function applyFlags(next: RouterConfig): RouterConfig {
		const flagMode = pi.getFlag("router-mode");
		if (typeof flagMode === "string") {
			if (!ROUTER_MODES.includes(flagMode as RouterMode)) {
				throw new Error(`--router-mode must be one of: ${ROUTER_MODES.join(", ")}`);
			}
			next.mode = flagMode as RouterMode;
		}
		if (pi.getFlag("router-off") === true) next.enabled = false;
		return next;
	}

	function reloadConfig(ctx: ExtensionContext): boolean {
		try {
			config = applyFlags(loadConfig(ctx.cwd, ctx.isProjectTrusted()));
			updateStatus(ctx);
			return true;
		} catch (error) {
			config = { ...config, enabled: false };
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Router disabled because its configuration is invalid: ${message}`, "error");
			updateStatus(ctx);
			return false;
		}
	}

	function statusText(ctx: ExtensionContext): string {
		const lines = [
			`Pi Router: ${config.enabled ? "on" : "off"}`,
			`Policy: ${config.mode}${pinnedRoute ? ` (pinned to ${pinnedRoute})` : ""}`,
			`Classifier: ${modelKey(config.classifier.provider, config.classifier.model)} @ ${config.classifier.thinkingLevel ?? "off"}`,
			...ROUTE_NAMES.map((route) => {
				const target = config.models[route];
				return `${route}: ${modelKey(target.provider, target.model)} @ ${target.thinkingLevel ?? "current"}`;
			}),
		];
		const paths = getConfigPaths(ctx.cwd);
		lines.push(`Config: ${paths.project} (project), ${paths.global} (global)`);
		return lines.join("\n");
	}

	async function configure(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Router setup requires TUI or RPC mode", "error");
			return;
		}

		const scopeOptions = ctx.isProjectTrusted() ? ["project", "global"] : ["global"];
		const scope = await ctx.ui.select("Save router configuration where?", scopeOptions);
		if (!scope) return;
		const mode = await ctx.ui.select("Default routing policy", [...ROUTER_MODES]);
		if (!mode) return;

		await ctx.modelRegistry.refresh();
		const available = ctx.modelRegistry
			.getAvailable()
			.map((model) => modelKey(model.provider, model.id))
			.sort();
		if (available.length === 0) {
			ctx.ui.notify("No configured models are available. Configure authentication with /login first.", "error");
			return;
		}

		const classifier = await ctx.ui.select(
			`Classifier model (current: ${modelKey(config.classifier.provider, config.classifier.model)})`,
			available,
		);
		if (!classifier) return;
		const next: RouterConfig = { ...config, mode: mode as RouterMode, models: { ...config.models } };
		const classifierSeparator = classifier.indexOf("/");
		next.classifier = {
			...config.classifier,
			provider: classifier.slice(0, classifierSeparator),
			model: classifier.slice(classifierSeparator + 1),
		};

		for (const route of ROUTE_NAMES) {
			const current = config.models[route];
			const selected = await ctx.ui.select(
				`${route[0].toUpperCase()}${route.slice(1)} route (current: ${modelKey(current.provider, current.model)})`,
				available,
			);
			if (!selected) return;
			const separator = selected.indexOf("/");
			next.models[route] = {
				...current,
				provider: selected.slice(0, separator),
				model: selected.slice(separator + 1),
			};
		}

		const paths = getConfigPaths(ctx.cwd);
		const path = scope === "project" ? paths.project : paths.global;
		await saveConfig(path, next);
		reloadConfig(ctx);
		ctx.ui.notify(`Router configuration saved to ${path}`, "info");
	}

	async function classify(prompt: string, hasImages: boolean, ctx: ExtensionContext) {
		const classifier = ctx.modelRegistry.find(config.classifier.provider, config.classifier.model);
		if (!classifier) throw new Error(`classifier model not found: ${modelKey(config.classifier.provider, config.classifier.model)}`);
		const provider = ctx.modelRegistry.getProvider(classifier.provider);
		if (!provider) throw new Error(`classifier provider not found: ${classifier.provider}`);
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(classifier);
		if (!auth.ok) throw new Error(auth.error);

		const usage = ctx.getContextUsage();
		const input = {
			prompt: truncatePrompt(prompt, config.maxPromptChars),
			mode: config.mode,
			currentRoute: currentRoute(config, ctx),
			contextRatio: usage?.percent === null || usage?.percent === undefined ? undefined : usage.percent / 100,
			hasImages,
			recentConversation: getRecentConversation(ctx, prompt, config.contextMessages, config.maxContextChars),
			models: config.models,
		};
		const response = await provider
			.streamSimple(
				classifier,
				{
					systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: buildClassifierPrompt(input) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					maxTokens: config.classifierMaxTokens,
					timeoutMs: config.classifierTimeoutMs,
					maxRetries: 1,
					temperature: 0,
					...(config.classifier.thinkingLevel && config.classifier.thinkingLevel !== "off"
						? { reasoning: config.classifier.thinkingLevel }
						: {}),
					cacheRetention: "short",
					sessionId: `pi-router:${ctx.sessionManager.getSessionId()}`,
					signal: ctx.signal,
				},
			)
			.result();
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return {
			decision: parseClassifierDecision(text),
			usage: response.usage,
			classifier: modelKey(classifier.provider, classifier.id),
		};
	}

	async function applyRoute(event: { prompt: string; images?: readonly unknown[] }, ctx: ExtensionContext) {
		if (!config.enabled) return;

		let decision: ClassifierDecision;
		let classifierUsage: unknown;
		let classifierName: string | undefined;
		if (pinnedRoute) {
			decision = fallbackDecision(pinnedRoute, `Pinned to ${pinnedRoute}`);
		} else {
			try {
				const classified = await classify(event.prompt, Boolean(event.images?.length), ctx);
				decision = classified.decision;
				classifierUsage = classified.usage;
				classifierName = classified.classifier;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const route = currentRoute(config, ctx) ?? config.fallbackRoute;
				decision = fallbackDecision(route, `Classifier failed; using ${route}: ${message}`);
				ctx.ui.notify(decision.reason, "warning");
			}
		}

		const recommendedRoute = decision.route;
		const classifierRanking = [...decision.ranking];
		const classifierReason = decision.reason;
		const activeRoute = currentRoute(config, ctx);
		if (
			!pinnedRoute &&
			classifierName &&
			activeRoute &&
			decision.route !== activeRoute &&
			decision.confidence < config.minSwitchConfidence
		) {
			decision.ranking = [activeRoute, ...decision.ranking.filter((route) => route !== activeRoute)];
			decision.route = activeRoute;
			decision.reason = `Kept current route at ${(decision.confidence * 100).toFixed(0)}% classifier confidence; ${classifierReason}`;
		}

		const failures: string[] = [];
		const availableKeys = new Set(
			ctx.modelRegistry.getAvailable().map((model) => modelKey(model.provider, model.id)),
		);
		const scopedModels = new Map(
			ctx.scopedModels.map((item) => [modelKey(item.model.provider, item.model.id), item] as const),
		);
		for (const route of decision.ranking) {
			const target = config.models[route];
			const key = modelKey(target.provider, target.model);
			const scoped = scopedModels.get(key);
			if (scopedModels.size > 0 && !scoped) {
				failures.push(`${route}: outside the current model scope`);
				continue;
			}
			if (!availableKeys.has(key)) {
				failures.push(`${route}: model unavailable`);
				continue;
			}
			const model = scoped?.model ?? ctx.modelRegistry.find(target.provider, target.model);
			if (!model) {
				failures.push(`${route}: model not found`);
				continue;
			}
			if (event.images?.length && !model.input.includes("image")) {
				failures.push(`${route}: no image input`);
				continue;
			}

			const changed = !ctx.model || ctx.model.provider !== model.provider || ctx.model.id !== model.id;
			if (changed) {
				try {
					if (!(await pi.setModel(model))) {
						failures.push(`${route}: authentication unavailable`);
						continue;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failures.push(`${route}: model switch failed: ${message}`);
					continue;
				}
			}
			const thinkingLevel = scoped?.thinkingLevel ?? target.thinkingLevel;
			if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);

			const usedFallback = route !== decision.route;
			const selectionReason = usedFallback
				? `Used ${route} after ${decision.route} was unavailable (${failures.join("; ")})`
				: decision.reason;
			lastRoute = route;
			lastModel = model.id;
			updateStatus(ctx);
			if (config.logDecisions) {
				pi.appendEntry("pi-router-decision", {
					timestamp: Date.now(),
					mode: config.mode,
					route,
					recommendedRoute,
					ranking: classifierRanking,
					confidence: decision.confidence,
					reason: selectionReason,
					classifierReason,
					provider: model.provider,
					model: model.id,
					thinkingLevel: pi.getThinkingLevel(),
					classifier: classifierName,
					classifierUsage,
				});
			}
			if (config.notify) {
				const decisionLabel = pinnedRoute
					? "pinned"
					: usedFallback
						? "fallback"
						: `${(decision.confidence * 100).toFixed(0)}%`;
				ctx.ui.notify(`Router → ${route}: ${model.id} (${decisionLabel} — ${selectionReason})`, "info");
			}
			return;
		}

		ctx.ui.notify(`Router could not select a model: ${failures.join("; ")}`, "error");
	}

	pi.registerCommand("router", {
		description: "Configure and control LLM-based model routing",
		handler: async (args, ctx) => {
			const input = args.trim();
			const [action = "status", ...rest] = input.split(/\s+/);

			if (action === "status") {
				ctx.ui.notify(statusText(ctx), "info");
				return;
			}
			if (action === "setup" || action === "config") {
				await configure(ctx);
				return;
			}
			if (action === "reload") {
				if (reloadConfig(ctx)) ctx.ui.notify("Router configuration reloaded", "info");
				return;
			}
			if (action === "on" || action === "off") {
				config.enabled = action === "on";
				updateStatus(ctx);
				ctx.ui.notify(`Router ${action}`, "info");
				return;
			}
			if (ROUTER_MODES.includes(action as RouterMode)) {
				config.mode = action as RouterMode;
				pinnedRoute = undefined;
				updateStatus(ctx);
				ctx.ui.notify(`Router policy: ${action}`, "info");
				return;
			}
			if (action === "use") {
				const route = rest[0];
				if (!ROUTE_NAMES.includes(route as RouteName)) {
					ctx.ui.notify(`Usage: /router use ${ROUTE_NAMES.join("|")}`, "error");
					return;
				}
				pinnedRoute = route as RouteName;
				updateStatus(ctx);
				ctx.ui.notify(`Router pinned to ${route}`, "info");
				return;
			}
			if (action === "auto") {
				pinnedRoute = undefined;
				updateStatus(ctx);
				ctx.ui.notify(`Router automatic mode (${config.mode})`, "info");
				return;
			}
			if (action === "test") {
				const prompt = rest.join(" ");
				if (!prompt) {
					ctx.ui.notify("Usage: /router test <prompt>", "error");
					return;
				}
				try {
					const result = await classify(prompt, false, ctx);
					ctx.ui.notify(
						`${result.decision.route} (${(result.decision.confidence * 100).toFixed(0)}%)\n${result.decision.reason}\nRanking: ${result.decision.ranking.join(" → ")}\nClassifier: ${result.classifier}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`Classifier failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			ctx.ui.notify(
				"Usage: /router [status|setup|reload|on|off|cost|balance|intelligence|auto|use <route>|test <prompt>]",
				"error",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await applyRoute(event, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (lastRoute && event.model.id !== lastModel) lastModel = event.model.id;
		updateStatus(ctx);
	});
}
