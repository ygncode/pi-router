import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import modelRouterExtension from "../src/index.js";
import type { ThinkingLevel } from "../src/types.js";

type Handler = (event: any, ctx: ExtensionContext) => Promise<void> | void;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function model(provider: string, id: string, input: Array<"text" | "image"> = ["text"]) {
	return { provider, id, input } as any;
}

const models = {
	classifier: model("deepseek", "deepseek-v4-flash"),
	fast: model("openai-codex", "gpt-5.6-luna", ["text", "image"]),
	balanced: model("openai-codex", "gpt-5.6-terra", ["text", "image"]),
	frontier: model("openai-codex", "gpt-5.6-sol", ["text", "image"]),
	efficient: model("deepseek", "deepseek-v4-pro"),
};

function createHarness(options?: {
	available?: any[];
	scopedModels?: Array<{ model: any; thinkingLevel?: ThinkingLevel }>;
	currentModel?: any;
	flags?: Record<string, boolean | string | undefined>;
	cwd?: string;
	trusted?: boolean;
	classifierResponse?: string;
	setModel?: (model: any) => Promise<boolean>;
}) {
	const events = new Map<string, Handler>();
	let command: CommandHandler | undefined;
	let thinkingLevel: ThinkingLevel = "medium";
	const notifications: Array<{ message: string; level: string }> = [];
	const setModel = vi.fn(options?.setModel ?? (async () => true));
	const setThinkingLevel = vi.fn((level: ThinkingLevel) => {
		thinkingLevel = level;
	});
	const appendEntry = vi.fn();
	const flags = options?.flags ?? {};
	const streamSimple = vi.fn((_model: any, _context: any, _options?: any) => ({
		result: async () => ({
			content: [
				{
					type: "text",
					text:
						options?.classifierResponse ??
						'{"route":"balanced","ranking":["balanced","fast","frontier","efficient"],"confidence":0.9,"reason":"Normal task"}',
				},
			],
			usage: {},
		}),
	}));

	const pi = {
		registerFlag: vi.fn(),
		getFlag: vi.fn((name: string) => flags[name]),
		registerCommand: vi.fn((_name: string, definition: { handler: CommandHandler }) => {
			command = definition.handler;
		}),
		on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
		setModel,
		setThinkingLevel,
		getThinkingLevel: vi.fn(() => thinkingLevel),
		appendEntry,
	} as unknown as ExtensionAPI;

	modelRouterExtension(pi);

	const allModels = Object.values(models);
	const ctx = {
		cwd: options?.cwd ?? process.cwd(),
		hasUI: true,
		mode: "tui",
		model: options?.currentModel ?? models.balanced,
		scopedModels: options?.scopedModels ?? [],
		thinkingLevel,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: vi.fn(),
		},
		modelRegistry: {
			getAvailable: () => options?.available ?? allModels,
			find: (provider: string, id: string) => allModels.find((item) => item.provider === provider && item.id === id),
			getProvider: (provider: string) => (provider === "deepseek" ? { streamSimple } : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "test-session",
		},
		getContextUsage: () => undefined,
		isProjectTrusted: () => options?.trusted ?? false,
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		events,
		get command() {
			if (!command) throw new Error("router command was not registered");
			return command;
		},
		setModel,
		setThinkingLevel,
		appendEntry,
		streamSimple,
		notifications,
	};
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("model router extension", () => {
	it("honors scoped models and their pinned thinking levels", async () => {
		const harness = createHarness({
			scopedModels: [{ model: models.balanced, thinkingLevel: "xhigh" }],
		});
		await harness.command("use frontier", harness.ctx);
		await harness.events.get("before_agent_start")?.({ prompt: "hard task" }, harness.ctx);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(harness.appendEntry).toHaveBeenCalledWith(
			"pi-router-decision",
			expect.objectContaining({ route: "balanced" }),
		);
	});

	it("uses the configured provider to classify and apply an automatic route", async () => {
		const harness = createHarness({
			classifierResponse:
				'{"route":"frontier","ranking":["frontier","balanced","efficient","fast"],"confidence":0.92,"reason":"Difficult task"}',
		});
		await harness.events.get("before_agent_start")?.({ prompt: "investigate the cross-system failure" }, harness.ctx);

		expect(harness.streamSimple).toHaveBeenCalledOnce();
		expect(harness.setModel).toHaveBeenCalledWith(models.frontier);
		expect(harness.appendEntry).toHaveBeenCalledWith(
			"pi-router-decision",
			expect.objectContaining({ route: "frontier", classifier: "deepseek/deepseek-v4-flash" }),
		);
	});

	it("caps oversized requests while retaining their beginning and end", async () => {
		const harness = createHarness();
		const prompt = `BEGIN-${"x".repeat(60_000)}-END`;
		await harness.events.get("before_agent_start")?.({ prompt }, harness.ctx);

		const classifierContext = harness.streamSimple.mock.calls[0]?.[1] as any;
		const classifierPrompt = classifierContext.messages[0].content[0].text as string;
		expect(classifierPrompt).toContain("BEGIN-");
		expect(classifierPrompt).toContain("-END");
		expect(classifierPrompt).toContain("request truncated for routing");
		expect(classifierPrompt.length).toBeLessThan(52_000);
	});

	it("skips catalog models that are not currently available", async () => {
		const harness = createHarness({ available: [models.fast] });
		await harness.command("use frontier", harness.ctx);
		await harness.events.get("before_agent_start")?.({ prompt: "hard task" }, harness.ctx);

		expect(harness.setModel).toHaveBeenCalledTimes(1);
		expect(harness.setModel).toHaveBeenCalledWith(models.fast);
		expect(harness.appendEntry).toHaveBeenCalledWith(
			"pi-router-decision",
			expect.objectContaining({
				route: "fast",
				recommendedRoute: "frontier",
				reason: expect.stringContaining("frontier was unavailable"),
				provider: "openai-codex",
				model: "gpt-5.6-luna",
			}),
		);
	});

	it("tries the next ranked model when switching throws", async () => {
		const harness = createHarness({
			setModel: async (selected) => {
				if (selected === models.frontier) throw new Error("credential command failed");
				return true;
			},
		});
		await harness.command("use frontier", harness.ctx);
		await harness.events.get("before_agent_start")?.({ prompt: "hard task" }, harness.ctx);

		expect(harness.setModel.mock.calls.map(([selected]) => selected)).toEqual([models.frontier, models.fast]);
		expect(harness.appendEntry).toHaveBeenCalledWith(
			"pi-router-decision",
			expect.objectContaining({
				route: "fast",
				recommendedRoute: "frontier",
				reason: expect.stringContaining("frontier: model switch failed: credential command failed"),
			}),
		);
	});

	it("preserves the classifier recommendation when confidence keeps the current route", async () => {
		const classifierRanking = ["frontier", "balanced", "efficient", "fast"];
		const harness = createHarness({
			classifierResponse: JSON.stringify({
				route: "frontier",
				ranking: classifierRanking,
				confidence: 0.4,
				reason: "Potentially difficult task",
			}),
		});
		await harness.events.get("before_agent_start")?.({ prompt: "investigate this" }, harness.ctx);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.appendEntry).toHaveBeenCalledWith(
			"pi-router-decision",
			expect.objectContaining({
				route: "balanced",
				recommendedRoute: "frontier",
				ranking: classifierRanking,
				classifierReason: "Potentially difficult task",
				reason: expect.stringContaining("Kept current route"),
			}),
		);
	});

	it("fails closed when project configuration is invalid", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-router-test-"));
		temporaryDirectories.push(cwd);
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi", "router.json"), '{"enabled":"false"}\n');
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-config");
		try {
			const harness = createHarness({ cwd, trusted: true });

			await harness.events.get("session_start")?.({ reason: "startup" }, harness.ctx);
			await harness.events.get("before_agent_start")?.({ prompt: "do not route" }, harness.ctx);

			expect(harness.setModel).not.toHaveBeenCalled();
			expect(harness.notifications).toContainEqual(
				expect.objectContaining({ level: "error", message: expect.stringContaining("Router disabled") }),
			);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
