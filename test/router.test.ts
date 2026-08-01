import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { buildClassifierPrompt, parseClassifierDecision } from "../src/router.js";

describe("parseClassifierDecision", () => {
	it("parses a valid classifier response", () => {
		const decision = parseClassifierDecision(
			'{"route":"frontier","ranking":["frontier","balanced","efficient","fast"],"confidence":0.86,"reason":"Complex debugging"}',
		);
		expect(decision).toEqual({
			route: "frontier",
			ranking: ["frontier", "balanced", "efficient", "fast"],
			confidence: 0.86,
			reason: "Complex debugging",
		});
	});

	it("extracts JSON from accidental markdown", () => {
		const decision = parseClassifierDecision(
			'```json\n{"route":"fast","ranking":["fast"],"confidence":0.9,"reason":"Small task"}\n```',
		);
		expect(decision.route).toBe("fast");
		expect(decision.ranking).toEqual(["fast", "balanced", "frontier", "efficient"]);
	});

	it("deduplicates ranking and puts the selected route first", () => {
		const decision = parseClassifierDecision(
			'{"route":"efficient","ranking":["frontier","efficient","frontier"],"confidence":2,"reason":"Cost effective"}',
		);
		expect(decision.ranking).toEqual(["efficient", "frontier", "fast", "balanced"]);
		expect(decision.confidence).toBe(1);
	});

	it("rejects an invalid route", () => {
		expect(() => parseClassifierDecision('{"route":"huge","confidence":1}')).toThrow("invalid route");
	});
});

describe("buildClassifierPrompt", () => {
	it("includes policy, targets, context, and current request", () => {
		const prompt = buildClassifierPrompt({
			prompt: "Investigate the failure",
			mode: "balance",
			currentRoute: "balanced",
			contextRatio: 0.72,
			hasImages: false,
			recentConversation: "user: It fails in production",
			models: DEFAULT_CONFIG.models,
		});
		expect(prompt).toContain("Routing policy: balance");
		expect(prompt).toContain("Current route: balanced");
		expect(prompt).toContain("Conversation context usage: 72%");
		expect(prompt).toContain("frontier: openai-codex/gpt-5.6-sol");
		expect(prompt).toContain("Investigate the failure");
	});
});

describe("router config", () => {
	it("configures the classifier independently from target models", () => {
		const config = mergeConfig(DEFAULT_CONFIG, {
			classifier: { provider: "custom", model: "cheap-model", thinkingLevel: "off" },
			minSwitchConfidence: 0.8,
		});
		expect(config.classifier).toEqual({ provider: "custom", model: "cheap-model", thinkingLevel: "off" });
		expect(config.minSwitchConfidence).toBe(0.8);
		expect(config.models.fast.model).toBe("gpt-5.6-luna");
	});

	it("rejects invalid and unknown settings instead of silently using defaults", () => {
		expect(() => mergeConfig(DEFAULT_CONFIG, { enabled: "false" })).toThrow("router.enabled must be a boolean");
		expect(() => mergeConfig(DEFAULT_CONFIG, { contextMessage: 0 })).toThrow("not a recognized setting");
		expect(() => mergeConfig(DEFAULT_CONFIG, { contextMessages: 1.5 })).toThrow("must be an integer");
	});

	it("allows null to request the provider's default thinking level", () => {
		const config = mergeConfig(DEFAULT_CONFIG, {
			models: { fast: { thinkingLevel: null } },
		});
		expect(config.models.fast.thinkingLevel).toBeUndefined();
	});
});
