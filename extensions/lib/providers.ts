// ========================================================================
// Provider templates
// ========================================================================
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth";
import { AssistantMessageEventStream, streamSimple, type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getModels, subProviderName, type SubEntry } from "./core.ts";

export type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };
export type GeminiCredentials = OAuthCredentials & { projectId?: string };

/** Native omp provider OAuth configuration. */
export type ProviderOAuth = NonNullable<ProviderConfig["oauth"]>;

export function requireOAuthDefinition(providerId: string) {
	const definition = getProviderDefinition(providerId);
	if (!definition || typeof definition.login !== "function" || typeof definition.refreshToken !== "function") {
		throw new Error(`No renewable OAuth flow available for provider "${providerId}"`);
	}
	return definition;
}

export function getRegisteredProviderApiKey(providerId: string, credentials: OAuthCredentials): string {
	switch (providerId) {
		case "anthropic":
		case "openai-codex":
		case "kimi-code":
		case "xai-oauth":
			return credentials.access;
		case "github-copilot":
		case "google-gemini-cli":
		case "google-antigravity": {
			const registered = credentials as OAuthCredentials & {
				apiEndpoint?: string;
				enterpriseUrl?: string;
				projectId?: string;
				email?: string;
				accountId?: string;
			};
			return JSON.stringify({
				apiEndpoint: registered.apiEndpoint,
				token: registered.access,
				enterpriseUrl: registered.enterpriseUrl,
				projectId: registered.projectId,
				refreshToken: registered.refresh,
				expiresAt: registered.expires,
				email: registered.email,
				accountId: registered.accountId,
			});
		}
		default:
			return credentials.access;
	}
}

export function flowBackedOAuth(providerId: string, name: string): ProviderOAuth {
	const definition = requireOAuthDefinition(providerId);
	return {
		name,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string> {
			const credentials = await definition.login(callbacks);
			if (typeof credentials === "string") {
				throw new Error(`No renewable OAuth flow available for provider "${providerId}"`);
			}
			return credentials;
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return definition.refreshToken(credentials);
		},
		getApiKey(credentials: OAuthCredentials): string {
			return getRegisteredProviderApiKey(providerId, credentials);
		},
	};
}

export function buildApiKeyOAuth(displayName: string, index: number, placeholder: string): ProviderOAuth {
	return {
		name: `${displayName} #${index}`,
		async login(callbacks: OAuthLoginCallbacks): Promise<string> {
			const key = (await callbacks.onPrompt({
				message: `Paste your ${displayName} API key:`,
				placeholder,
			})).trim();
			if (!key) throw new Error(`No API key entered for ${displayName} #${index}`);
			return key; // string return -> OMP stores {type:"api_key", key} under this provider
		},
	};
}

const CURSOR_EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

function cursorJwtExpiryMs(jwt: string): number {
	const fallback = Date.now() + 55 * 60 * 1000;
	const parts = jwt.split(".");
	if (parts.length !== 3) return fallback;
	try {
		const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
		return typeof payload.exp === "number" ? payload.exp * 1000 : fallback;
	} catch {
		return fallback;
	}
}

async function exchangeCursorApiKey(apiKey: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	const resp = await fetch(CURSOR_EXCHANGE_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: "{}",
		signal,
	});
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`Cursor API key exchange failed (${resp.status}): ${text || resp.statusText}`);
	}
	const data = (await resp.json()) as { accessToken?: string };
	if (!data.accessToken) throw new Error("Cursor API key exchange returned no accessToken");
	return { access: data.accessToken, refresh: apiKey, expires: cursorJwtExpiryMs(data.accessToken) };
}

const CURSOR_API_KEY_PREFIXES = ["crsr_", "cursor_"];

export function buildCursorOAuth(index: number): ProviderOAuth {
	const definition = requireOAuthDefinition("cursor");
	return {
		name: `Cursor #${index}`,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const apiKey = (await callbacks.onPrompt({
				message: "Paste your Cursor API key (crsr_...), or leave blank to sign in with your browser:",
				placeholder: "crsr_...  (blank = browser sign-in)",
				allowEmpty: true,
			})).trim();
			if (apiKey) return exchangeCursorApiKey(apiKey, callbacks.signal);
			const credentials = await definition.login(callbacks);
			if (typeof credentials === "string") {
				throw new Error(`Cursor #${index} browser login did not return renewable credentials`);
			}
			return credentials;
		},
		async refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
			const refresh = credentials.refresh || credentials.access;
			if (CURSOR_API_KEY_PREFIXES.some((prefix) => refresh.startsWith(prefix))) {
				return exchangeCursorApiKey(refresh, signal);
			}
			return definition.refreshToken(credentials, signal);
		},
		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}



// GitHub Copilot base URL derivation, ported from the pi-ai OAuth flow
// (no longer part of the public pi-ai surface).

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

export function getBaseUrlFromCopilotToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	// Convert proxy.xxx to api.xxx
	return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

export function getGitHubCopilotBaseUrl(token: string | undefined, enterpriseUrl: string | undefined): string {
	if (token) {
		const fromToken = getBaseUrlFromCopilotToken(token);
		if (fromToken) return fromToken;
	}
	const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : null;
	if (domain) return `https://copilot-api.${domain}`;
	return "https://api.individual.githubcopilot.com";
}

// Synthetic provider names change provider-keyed transports. These APIs route
// through one shared wrapper, which restores canonical identity only inside
// transport and puts subscription identity back on emitted assistant messages.
export const SUB_TRANSPORT_CONFIG: Record<string, { builtinApi: Api | ((modelId: string) => Api); customApiId: string }> = {
	"google-antigravity": { builtinApi: "google-gemini-cli", customApiId: "google-antigravity-mp" },
};


const ANTIGRAVITY_ZWSP = "\u200B";

/** Substrings that make up Cloud Code Assist's system-prompt abuse fingerprint
 * (omp #11699, #12655). The live trigger is the `<conventions>` tag plus the
 * `RFC 2119: ...` sentence; breaking any one component defeats it. */
export const ANTIGRAVITY_FINGERPRINTS = ["RFC 2119", "<conventions>", "</conventions>"] as const;

/** Break Cloud Code Assist's system-prompt fingerprint so it stops masking
 * requests as 429 RESOURCE_EXHAUSTED (omp #11699, #12655). A zero-width space is
 * inserted into each flagged substring: invisible to the model, but it breaks
 * the contiguous literal the upstream WAF matches. Idempotent — a second pass
 * finds no intact substring. Content is otherwise preserved. */
export function defeatAntigravityFingerprint(text: string): string {
	let out = text;
	for (const s of ANTIGRAVITY_FINGERPRINTS) {
		out = out.split(s).join(s[0] + ANTIGRAVITY_ZWSP + s.slice(1));
	}
	return out;
}

export function rewriteAntigravitySystemInstruction(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const body = payload as Record<string, unknown>;
	const request = body.request;
	if (!request || typeof request !== "object") return payload;
	const req = request as Record<string, unknown>;
	const sys = req.systemInstruction;
	if (!sys || typeof sys !== "object") return payload;
	const sysObj = sys as Record<string, unknown>;
	if (!Array.isArray(sysObj.parts)) return payload;
	const parts = sysObj.parts.map(part =>
		part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
			? { ...part, text: defeatAntigravityFingerprint((part as { text: string }).text) }
			: part,
	);
	return { ...body, request: { ...req, systemInstruction: { ...sysObj, parts } } };
}

export type SubscriptionStream = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function restoreSubscriptionProvider(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: { ...event.message, provider } };
	if (event.type === "error") return { ...event, error: { ...event.error, provider } };
	return { ...event, partial: { ...event.partial, provider } };
}

export function createSubscriptionStream(canonicalProvider: string, builtinApi: Api | ((modelId: string) => Api)): SubscriptionStream {
	return (model, context, options) => {
		const internalApi = typeof builtinApi === "function" ? builtinApi(model.id) : builtinApi;
		const baseModel = getModels(canonicalProvider).find(candidate => candidate.id === model.id);
		if (!baseModel) throw new Error(`Missing bundled model ${canonicalProvider}/${model.id}`);
		const internalModel = { ...baseModel, api: internalApi, provider: canonicalProvider } as Model<Api>;
		const internalOptions: SimpleStreamOptions = {
			...(options ?? {}),
			headers: options?.headers,
			onPayload: async (payload: unknown) => {
				const rewritten =
					canonicalProvider === "google-antigravity"
						? rewriteAntigravitySystemInstruction(payload)
						: payload;
				const replacement = await options?.onPayload?.(rewritten, model);
				return replacement ?? rewritten;
			},
			onSseEvent: options?.onSseEvent
				? (event: Parameters<NonNullable<SimpleStreamOptions["onSseEvent"]>>[0]) => options.onSseEvent?.(event, model)
				: undefined,
		};
		const inner = streamSimple(internalModel, context, internalOptions);
		const outer = new AssistantMessageEventStream();
		outer.forwardLocalWorkFrom(inner);
		void (async () => {
			try {
				for await (const event of inner) {
					outer.push(restoreSubscriptionProvider(event, model.provider));
				}
			} catch (error) {
				outer.fail(error);
			}
		})();
		return outer;
	};
}
export const SUBSCRIPTION_STREAMS: Record<string, SubscriptionStream> = {};
export function getSubscriptionStream(baseProvider: string): SubscriptionStream | undefined {
	const config = SUB_TRANSPORT_CONFIG[baseProvider];
	if (!config) return undefined;
	let stream = SUBSCRIPTION_STREAMS[baseProvider];
	if (!stream) {
		stream = createSubscriptionStream(baseProvider, config.builtinApi);
		SUBSCRIPTION_STREAMS[baseProvider] = stream;
	}
	return stream;
}



export interface ProviderTemplate {
	displayName: string;
	buildOAuth?(index: number): ProviderOAuth;
	buildModifyModels?(providerName: string): ProviderOAuth["modifyModels"];
}

interface ApiKeyProviderSpec {
	id: string; // bundled-catalog provider id
	displayName: string;
	placeholder: string; // key-format hint shown in the login prompt
}

// Direct-API-key providers with a static baseUrl and bearer auth in the bundled
// catalog. Add a row to support another; no other code changes are required.
export const API_KEY_PROVIDERS: ApiKeyProviderSpec[] = [
	{ id: "openai", displayName: "OpenAI (API key)", placeholder: "sk-..." },
	{ id: "deepseek", displayName: "DeepSeek", placeholder: "sk-..." },
	{ id: "mistral", displayName: "Mistral", placeholder: "..." },
	{ id: "groq", displayName: "Groq", placeholder: "gsk_..." },
	{ id: "xai", displayName: "xAI (API key)", placeholder: "xai-..." },
	{ id: "google", displayName: "Google Gemini (API key)", placeholder: "AIza..." },
	{ id: "openrouter", displayName: "OpenRouter", placeholder: "sk-or-..." },
	{ id: "together", displayName: "Together AI", placeholder: "..." },
	{ id: "fireworks", displayName: "Fireworks AI", placeholder: "fw_..." },
	{ id: "cerebras", displayName: "Cerebras", placeholder: "csk-..." },
	{ id: "moonshot", displayName: "Moonshot (Kimi)", placeholder: "sk-..." },
	{ id: "zai", displayName: "Z.AI (GLM)", placeholder: "..." },
	{ id: "minimax", displayName: "MiniMax (Global)", placeholder: "..." },
	{ id: "minimax-cn", displayName: "MiniMax (China)", placeholder: "..." },
];

export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
	anthropic: {
		displayName: "Anthropic (Claude Pro/Max)",
		buildOAuth(index: number) {
			return flowBackedOAuth("anthropic", `Anthropic #${index}`);
		},
	},

	"openai-codex": {
		displayName: "ChatGPT Plus/Pro (Codex)",
		buildOAuth(index: number) {
			return flowBackedOAuth("openai-codex", `ChatGPT Codex #${index}`);
		},
	},

	"github-copilot": {
		displayName: "GitHub Copilot",
		buildOAuth(index: number) {
			return flowBackedOAuth("github-copilot", `GitHub Copilot #${index}`);
		},
		buildModifyModels(providerName: string) {
			return (models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] => {
				const creds = credentials as CopilotCredentials;
				const baseUrl = getGitHubCopilotBaseUrl(creds.access, creds.enterpriseUrl);
				return models.map((m) =>
					m.provider === providerName ? { ...m, baseUrl } : m,
				);
			};
		},
	},

	"google-gemini-cli": {
		displayName: "Google Cloud Code Assist",
		buildOAuth(index: number) {
			return flowBackedOAuth("google-gemini-cli", `Google Cloud Code Assist #${index}`);
		},
	},

	"google-antigravity": {
		displayName: "Antigravity",
		buildOAuth(index: number) {
			return flowBackedOAuth("google-antigravity", `Antigravity #${index}`);
		},
	},

	"kimi-code": {
		displayName: "Kimi Code",
		buildOAuth(index: number) {
			return flowBackedOAuth("kimi-code", `Kimi Code #${index}`);
		},
	},

	"xai-oauth": {
		displayName: "xAI Grok OAuth",
		buildOAuth(index: number) {
			return flowBackedOAuth("xai-oauth", `xAI Grok OAuth #${index}`);
		},
	},

	cursor: {
		displayName: "Cursor",
		buildOAuth(index: number) {
			return buildCursorOAuth(index);
		},
	},

};

for (const spec of API_KEY_PROVIDERS) {
	PROVIDER_TEMPLATES[spec.id] = {
		displayName: spec.displayName,
		buildOAuth: (index: number) => buildApiKeyOAuth(spec.displayName, index, spec.placeholder),
	};
}


export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

export function subDisplayName(entry: SubEntry): string {
	const template = PROVIDER_TEMPLATES[entry.provider];
	const providerName = `${template?.displayName || entry.provider} #${entry.index}`;
	if (!entry.label) return providerName;
	return `${entry.label} — ${providerName}`;
}
export function getBaseProvider(providerName: string): string | undefined {
	// Direct match
	if (PROVIDER_TEMPLATES[providerName]) return providerName;
	// Strip trailing -N
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && PROVIDER_TEMPLATES[match[1]]) return match[1];
	return undefined;
}

// ==========================================================================
// Model cloning
// ==========================================================================

export function cloneModels(originalProvider: string, index: number): ProviderModelConfig[] {
	const models = getModels(originalProvider);
	return models.map((m) => ({
		id: m.id,
		name: `${m.name} (#${index})`,
		api: SUB_TRANSPORT_CONFIG[originalProvider]?.customApiId ?? m.api,
		reasoning: m.reasoning,
		thinking: m.thinking,
		input: m.input as ("text" | "image")[],
		cost: { ...m.cost },
		premiumMultiplier: m.premiumMultiplier,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		preferWebsockets: m.preferWebsockets,
		headers: m.headers ? { ...m.headers } : undefined,
		compat: m.compat,
	}));
}


// ==========================================================================
// Register a single subscription as a provider
// ==========================================================================

export function registerSub(pi: ExtensionAPI, entry: SubEntry): void {
	const template = PROVIDER_TEMPLATES[entry.provider];
	if (!template) return;
	const name = subProviderName(entry);
	const oauth = template.buildOAuth?.(entry.index);
	const modifyModels = template.buildModifyModels?.(name);

	const builtinModels = getModels(entry.provider);
	const transportApi = SUB_TRANSPORT_CONFIG[entry.provider]?.customApiId;
	const streamSimple = getSubscriptionStream(entry.provider);
	const baseUrl = builtinModels[0]?.baseUrl || "";
	const models = cloneModels(entry.provider, entry.index);

	// Static `models` provide startup catalog for this subscription.
	pi.registerProvider(name, {
		baseUrl,
		api: transportApi ?? builtinModels[0]?.api,
		streamSimple,
		oauth: oauth && modifyModels ? { ...oauth, modifyModels } : oauth,
		models,
	});
}
