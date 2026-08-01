export const ROUTE_NAMES = ["fast", "balanced", "frontier", "efficient"] as const;
export const ROUTER_MODES = ["cost", "balance", "intelligence"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RouteName = (typeof ROUTE_NAMES)[number];
export type RouterMode = (typeof ROUTER_MODES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelTarget {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RouterConfig {
	enabled: boolean;
	mode: RouterMode;
	notify: boolean;
	logDecisions: boolean;
	classifier: ModelTarget;
	classifierMaxTokens: number;
	classifierTimeoutMs: number;
	contextMessages: number;
	maxContextChars: number;
	maxPromptChars: number;
	minSwitchConfidence: number;
	fallbackRoute: RouteName;
	models: Record<RouteName, ModelTarget>;
}

export interface ClassifierInput {
	prompt: string;
	mode: RouterMode;
	currentRoute?: RouteName;
	contextRatio?: number;
	hasImages?: boolean;
	recentConversation?: string;
	models: Record<RouteName, ModelTarget>;
}

export interface ClassifierDecision {
	route: RouteName;
	ranking: RouteName[];
	confidence: number;
	reason: string;
}
