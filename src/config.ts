import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ROUTER_MODES,
	ROUTE_NAMES,
	THINKING_LEVELS,
	type ModelTarget,
	type RouteName,
	type RouterConfig,
	type RouterMode,
	type ThinkingLevel,
} from "./types.js";

export const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	mode: "balance",
	notify: true,
	logDecisions: true,
	classifier: {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		thinkingLevel: "low",
	},
	classifierMaxTokens: 256,
	classifierTimeoutMs: 15_000,
	contextMessages: 6,
	maxContextChars: 6_000,
	maxPromptChars: 50_000,
	minSwitchConfidence: 0.7,
	fallbackRoute: "balanced",
	models: {
		fast: {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			thinkingLevel: "max",
		},
		balanced: {
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			thinkingLevel: "max",
		},
		frontier: {
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			thinkingLevel: "high",
		},
		efficient: {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			thinkingLevel: "high",
		},
	},
};

export interface ConfigPaths {
	global: string;
	project: string;
}

export function getConfigPaths(cwd: string): ConfigPaths {
	return {
		global: join(getAgentDir(), "router.json"),
		project: join(cwd, CONFIG_DIR_NAME, "router.json"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) throw new Error("top-level value must be an object");
		return parsed;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read ${path}: ${message}`);
	}
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${path}.${key} is not a recognized setting`);
	}
}

function parseBoolean(value: unknown, fallback: boolean, path: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	return value;
}

function parseTarget(value: unknown, fallback: ModelTarget, path: string): ModelTarget {
	if (value === undefined) return { ...fallback };
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	assertKnownKeys(value, ["provider", "model", "thinkingLevel"], path);

	const provider = value.provider === undefined ? fallback.provider : value.provider;
	if (typeof provider !== "string" || !provider.trim()) throw new Error(`${path}.provider must be a non-empty string`);
	const model = value.model === undefined ? fallback.model : value.model;
	if (typeof model !== "string" || !model.trim()) throw new Error(`${path}.model must be a non-empty string`);

	const thinking = value.thinkingLevel;
	let thinkingLevel = fallback.thinkingLevel;
	if (thinking === null) thinkingLevel = undefined;
	else if (thinking !== undefined) {
		if (typeof thinking !== "string" || !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
			throw new Error(`${path}.thinkingLevel must be null or one of: ${THINKING_LEVELS.join(", ")}`);
		}
		thinkingLevel = thinking as ThinkingLevel;
	}
	return { provider: provider.trim(), model: model.trim(), thinkingLevel };
}

function boundedNumber(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
	path: string,
	integer = false,
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${path} must be a number from ${minimum} to ${maximum}`);
	}
	if (integer && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
	return value;
}

/** Merge a partial config over a complete base config and validate known fields. */
export function mergeConfig(base: RouterConfig, partial: Record<string, unknown>): RouterConfig {
	assertKnownKeys(
		partial,
		[
			"enabled",
			"mode",
			"notify",
			"logDecisions",
			"classifier",
			"classifierMaxTokens",
			"classifierTimeoutMs",
			"contextMessages",
			"maxContextChars",
			"maxPromptChars",
			"minSwitchConfidence",
			"fallbackRoute",
			"models",
		],
		"router",
	);

	const modelsValue = partial.models === undefined ? {} : partial.models;
	if (!isRecord(modelsValue)) throw new Error("router.models must be an object");
	assertKnownKeys(modelsValue, ROUTE_NAMES, "router.models");

	let mode = base.mode;
	if (partial.mode !== undefined) {
		if (typeof partial.mode !== "string" || !ROUTER_MODES.includes(partial.mode as RouterMode)) {
			throw new Error(`router.mode must be one of: ${ROUTER_MODES.join(", ")}`);
		}
		mode = partial.mode as RouterMode;
	}

	let fallbackRoute = base.fallbackRoute;
	if (partial.fallbackRoute !== undefined) {
		if (typeof partial.fallbackRoute !== "string" || !ROUTE_NAMES.includes(partial.fallbackRoute as RouteName)) {
			throw new Error(`router.fallbackRoute must be one of: ${ROUTE_NAMES.join(", ")}`);
		}
		fallbackRoute = partial.fallbackRoute as RouteName;
	}

	return {
		enabled: parseBoolean(partial.enabled, base.enabled, "router.enabled"),
		mode,
		notify: parseBoolean(partial.notify, base.notify, "router.notify"),
		logDecisions: parseBoolean(partial.logDecisions, base.logDecisions, "router.logDecisions"),
		classifier: parseTarget(partial.classifier, base.classifier, "router.classifier"),
		classifierMaxTokens: boundedNumber(
			partial.classifierMaxTokens,
			base.classifierMaxTokens,
			64,
			2_048,
			"router.classifierMaxTokens",
			true,
		),
		classifierTimeoutMs: boundedNumber(
			partial.classifierTimeoutMs,
			base.classifierTimeoutMs,
			1_000,
			120_000,
			"router.classifierTimeoutMs",
			true,
		),
		contextMessages: boundedNumber(
			partial.contextMessages,
			base.contextMessages,
			0,
			30,
			"router.contextMessages",
			true,
		),
		maxContextChars: boundedNumber(
			partial.maxContextChars,
			base.maxContextChars,
			0,
			50_000,
			"router.maxContextChars",
			true,
		),
		maxPromptChars: boundedNumber(
			partial.maxPromptChars,
			base.maxPromptChars,
			1_000,
			200_000,
			"router.maxPromptChars",
			true,
		),
		minSwitchConfidence: boundedNumber(
			partial.minSwitchConfidence,
			base.minSwitchConfidence,
			0,
			1,
			"router.minSwitchConfidence",
		),
		fallbackRoute,
		models: {
			fast: parseTarget(modelsValue.fast, base.models.fast, "router.models.fast"),
			balanced: parseTarget(modelsValue.balanced, base.models.balanced, "router.models.balanced"),
			frontier: parseTarget(modelsValue.frontier, base.models.frontier, "router.models.frontier"),
			efficient: parseTarget(modelsValue.efficient, base.models.efficient, "router.models.efficient"),
		},
	};
}

export function cloneDefaultConfig(): RouterConfig {
	return mergeConfig(DEFAULT_CONFIG, {});
}

export function loadConfig(cwd: string, allowProjectConfig: boolean): RouterConfig {
	const paths = getConfigPaths(cwd);
	let config = mergeConfig(DEFAULT_CONFIG, readConfigFile(paths.global));
	if (allowProjectConfig) config = mergeConfig(config, readConfigFile(paths.project));
	return config;
}

export async function saveConfig(path: string, config: RouterConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
