// ========================================================================
// Built-in quota checking
// ========================================================================
import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { BorderedLoader } from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBaseProvider, subDisplayName, PROVIDER_TEMPLATES } from "./providers.ts";
import { getAuthStorage, adaptAuthStorage, getModels, subProviderName, type AuthStorageEntry, type MultiAuthConfig, type QuotaAccount, type QuotaCheckResult, type QuotaStatusKind, type ProviderQuotaChecker, type AuthStorage } from "./core.ts";
import { loadGlobalConfig, loadProjectConfig, parseEnvConfig, mergeConfigs, normalizeEntries } from "./config.ts";
import { getWrappedSelectIndex, showWrappedSelect } from "./ui.ts";
import type { SelectItem } from "@oh-my-pi/pi-tui";

export const DEFAULT_CODEX_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
export const GOOGLE_GEMINI_QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
export const GOOGLE_ANTIGRAVITY_QUOTA_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
	"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
] as const;
export const GOOGLE_GEMINI_HEADERS = {
	"User-Agent": "google-api-nodejs-client/9.15.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
};
export const GOOGLE_ANTIGRAVITY_HEADERS = {
	"User-Agent": "antigravity/1.11.9 windows/amd64",
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};
export const GOOGLE_ANTIGRAVITY_HIDDEN_MODELS = new Set(["tab_flash_lite_preview"]);
export const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
export const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

export interface CodexUsageWindow {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
}

export interface CodexUsageSnapshot {
	planType: string;
	email: string;
	fiveHour?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
}

export interface GoogleGeminiQuotaResponse {
	buckets?: Array<{
		modelId?: string;
		remainingFraction?: number;
		resetTime?: string;
	}>;
}

export interface GoogleAntigravityQuotaResponse {
	models?: Record<
		string,
		{
			displayName?: string;
			model?: string;
			isInternal?: boolean;
			quotaInfo?: {
				remainingFraction?: number;
				resetTime?: string;
			};
		}
	>;
}

export interface GoogleQuotaModelSnapshot {
	model: string;
	remainingPercent?: number;
	resetAt?: number;
	key?: string;
}

export interface GoogleQuotaAccountSnapshot {
	endpoint: string;
	projectId?: string;
	models: GoogleQuotaModelSnapshot[];
	worstRemainingPercent?: number;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function getCodexTokenMetadata(accessToken: string): {
	accountId?: string;
	planType?: string;
	email?: string;
} {
	const payload = decodeJwtPayload(accessToken);
	const auth = getRecord(payload[OPENAI_AUTH_CLAIM]);
	const profile = getRecord(payload[OPENAI_PROFILE_CLAIM]);
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	const planType = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
	const email = typeof profile?.email === "string" ? profile.email : undefined;
	return { accountId, planType, email };
}

export function normalizeCodexUsageWindow(window: unknown): CodexUsageWindow | undefined {
	const raw = getRecord(window);
	if (!raw) return undefined;
	const usedPercent = typeof raw.used_percent === "number" ? raw.used_percent : 0;
	const windowSeconds = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : 0;
	const resetAt = typeof raw.reset_at === "number" ? raw.reset_at : undefined;
	return {
		usedPercent,
		windowSeconds,
		resetAt,
	};
}

export function matchesUsageWindow(window: CodexUsageWindow | undefined, expectedSeconds: number): boolean {
	if (!window) return false;
	return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

export function parseCodexUsageSnapshot(data: unknown): CodexUsageSnapshot {
	const raw = getRecord(data);
	const rateLimit = getRecord(raw?.rate_limit);
	const windows = [
		normalizeCodexUsageWindow(rateLimit?.primary_window),
		normalizeCodexUsageWindow(rateLimit?.secondary_window),
	].filter((window): window is CodexUsageWindow => Boolean(window));
	const fiveHour = windows.find((window) => matchesUsageWindow(window, 5 * 60 * 60));
	const weekly = windows.find((window) => matchesUsageWindow(window, 7 * 24 * 60 * 60));
	return {
		planType: typeof raw?.plan_type === "string" ? raw.plan_type : "unknown",
		email: typeof raw?.email === "string" ? raw.email : "",
		fiveHour,
		weekly,
	};
}

export function getCodexWindowRemaining(window: CodexUsageWindow | undefined): number | undefined {
	if (!window) return undefined;
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function formatResetShort(resetAt?: number): string {
	if (!resetAt) return "--";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `~${days}d`;
	if (hours > 0) return `~${hours}h`;
	return `~${minutes}m`;
}

export function formatResetLong(resetAt?: number): string {
	if (!resetAt) return "unknown";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	return `in ${minutes}m`;
}

export function formatRemainingPercent(value: number | undefined): string {
	if (value === undefined) return "--";
	return `${Math.round(value)}%`;
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export function parseIsoTimestampSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.floor(parsed / 1000);
}

export async function readResponseError(response: Response): Promise<string> {
	const raw = await response.text();
	if (response.status === 401) {
		return "Unauthorized - log in again";
	}
	if (!raw) {
		return `HTTP ${response.status}`;
	}
	try {
		const parsed = JSON.parse(raw) as {
			error?: { message?: string };
			message?: string;
		};
		const message = parsed.error?.message || parsed.message;
		if (message) return `HTTP ${response.status}: ${message}`;
	} catch {
		// ignore JSON parse errors and fall back to raw text
	}
	return `HTTP ${response.status}: ${raw}`;
}

export function classifyCodexQuotaKind(snapshot: CodexUsageSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	const fiveHourLeft = getCodexWindowRemaining(snapshot.fiveHour);
	const weeklyLeft = getCodexWindowRemaining(snapshot.weekly);
	const values = [fiveHourLeft, weeklyLeft].filter((value): value is number => value !== undefined);
	if (values.length === 0) {
		return { kind: "error", score: 0 };
	}
	const bottleneck = Math.min(...values);
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

export function formatQuotaKind(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "ready";
		case "watch":
			return "watch";
		case "low":
			return "low";
		case "blocked":
			return "blocked";
		case "missing-auth":
			return "not logged in";
		default:
			return "error";
	}
}

export function compareQuotaResults(left: QuotaCheckResult, right: QuotaCheckResult): number {
	const rank = (kind: QuotaStatusKind): number => {
		switch (kind) {
			case "ready":
				return 0;
			case "watch":
				return 1;
			case "low":
				return 2;
			case "blocked":
				return 3;
			case "error":
				return 4;
			case "missing-auth":
				return 5;
		}
	};
	return rank(left.kind) - rank(right.kind)
		|| right.score - left.score
		|| left.account.displayName.localeCompare(right.account.displayName);
}

export function getQuotaStatusGlyph(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "✓";
		case "watch":
			return "◔";
		case "low":
			return "!";
		case "blocked":
			return "✕";
		case "missing-auth":
			return "○";
		default:
			return "?";
	}
}

export function formatQuotaOverview(results: QuotaCheckResult[]): string {
	const counts = {
		ready: 0,
		watch: 0,
		low: 0,
		blocked: 0,
		error: 0,
		missingAuth: 0,
	};

	for (const result of results) {
		switch (result.kind) {
			case "ready":
				counts.ready++;
				break;
			case "watch":
				counts.watch++;
				break;
			case "low":
				counts.low++;
				break;
			case "blocked":
				counts.blocked++;
				break;
			case "missing-auth":
				counts.missingAuth++;
				break;
			default:
				counts.error++;
		}
	}

	const parts = [`${results.length} ${results.length === 1 ? "account" : "accounts"}`];
	if (counts.ready > 0) parts.push(`${counts.ready} ready`);
	if (counts.watch > 0) parts.push(`${counts.watch} watch`);
	if (counts.low > 0) parts.push(`${counts.low} low`);
	if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
	if (counts.error > 0) parts.push(`${counts.error} error`);
	if (counts.missingAuth > 0) parts.push(`${counts.missingAuth} not logged in`);

	const best = results[0];
	if (best) {
		parts.push(`best now: ${best.account.displayName}`);
	}

	return parts.join(" • ");
}

export function formatQuotaCurrentHint(
	results: QuotaCheckResult[],
	currentProviderName: string | undefined,
	currentModel?: { id: string; name: string },
): string | undefined {
	if (!currentProviderName) return undefined;

	const current = results.find((result) => result.account.providerName === currentProviderName);
	if (!current) return undefined;

	let hint = `Current: ${current.account.displayName} is ${formatQuotaKind(current.kind)}`;
	if (current.googleSnapshot && currentModel) {
		const matches = matchGoogleQuotaModels(current.account.baseProvider, currentModel, current.googleSnapshot);
		const worst = pickWorstQuotaModel(matches);
		if (worst) {
			hint += ` • ${worst.model} ${formatRemainingPercent(worst.remainingPercent)} left`;
		}
	}
	const best = results[0];
	if (best && best.account.providerName !== current.account.providerName) {
		hint += ` • best available: ${best.account.displayName}`;
	}
	if (current.kind !== "ready") {
		hint += " • snapshot only: auto-switch happens after a runtime rate-limit error";
	}
	return hint;
}

export function buildQuotaSelectItems(
	results: QuotaCheckResult[],
	currentProviderName: string | undefined,
): SelectItem[] {
	const bestProviderName = results[0]?.account.providerName;
	return results.map((result) => {
		const badges: string[] = [];
		if (result.account.providerName === currentProviderName) badges.push("current");
		if (result.account.providerName === bestProviderName) badges.push("best now");
		const badgeSuffix = badges.length > 0 ? ` • ${badges.join(" • ")}` : "";

		return {
			value: result.account.providerName,
			label: `${getQuotaStatusGlyph(result.kind)} ${result.account.displayName}`,
			description: `${result.summary}${badgeSuffix}`,
		};
	});
}

export async function runQuotaChecks(
	accounts: QuotaAccount[],
	authStorage: AuthStorage,
	signal?: AbortSignal,
): Promise<QuotaCheckResult[]> {
	const results = await Promise.all(accounts.map(async (account) => {
		const checker = PROVIDER_QUOTA_CHECKERS.find(
			(candidate) => candidate.baseProvider === account.baseProvider,
		);
		if (!checker) return undefined;
		return checker.check(account, authStorage, signal);
	}));

	return results
		.filter((result): result is QuotaCheckResult => Boolean(result))
		.sort(compareQuotaResults);
}

export async function loadQuotaResults(
	ctx: ExtensionCommandContext,
	accounts: QuotaAccount[],
	authStorage: AuthStorage,
): Promise<QuotaCheckResult[] | null> {
	if (!ctx.hasUI) {
		return runQuotaChecks(accounts, authStorage);
	}

	return ctx.ui.custom<QuotaCheckResult[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			`Checking limits across ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}...`,
		);
		loader.onAbort = () => done(null);

		runQuotaChecks(accounts, authStorage, loader.signal)
			.then(done)
			.catch((error) => {
				if (loader.signal.aborted) {
					done(null);
					return;
				}
				console.error("Failed to load quota checks", error);
				done(null);
			});

		return loader;
	});
}

export async function selectQuotaResult(
	ctx: ExtensionCommandContext,
	results: QuotaCheckResult[],
	preferredProviderName?: string,
): Promise<QuotaCheckResult | undefined> {
	const currentProviderName = preferredProviderName || ctx.model?.provider;
	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Subscription Limits",
		subtitle: [
			"Select an account to inspect its full quota windows.",
			formatQuotaOverview(results),
			formatQuotaCurrentHint(results, currentProviderName, ctx.model),
		].filter(Boolean).join("\n"),
		items: buildQuotaSelectItems(results, currentProviderName),
		initialValue: currentProviderName,
		confirmHint: "inspect",
		cancelHint: "close",
	});
	if (!selectedProviderName) return undefined;
	return results.find((result) => result.account.providerName === selectedProviderName);
}

export function normalizeGoogleRemainingPercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, Math.round(value * 100)));
}

export function getGoogleProjectId(account: QuotaAccount, auth: AuthStorageEntry): string | undefined {
	if (typeof auth.projectId === "string" && auth.projectId.length > 0) {
		return auth.projectId;
	}

	if (account.baseProvider === "google-antigravity") {
		const projectId = process.env.GOOGLE_ANTIGRAVITY_PROJECT_ID || process.env.GOOGLE_ANTIGRAVITY_PROJECT;
		if (projectId) return projectId;
	}

	const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	return projectId || undefined;
}

export function updateGoogleQuotaModel(
	modelsByName: Map<string, GoogleQuotaModelSnapshot>,
	model: string,
	remainingPercent: number | undefined,
	resetAt: number | undefined,
	key?: string,
): void {
	const existing = modelsByName.get(model);
	if (!existing) {
		modelsByName.set(model, { model, remainingPercent, resetAt, key });
		return;
	}

	let next = existing;
	if (existing.key === undefined && key !== undefined) {
		next = { ...next, key };
	}
	if (remainingPercent !== undefined) {
		if (existing.remainingPercent === undefined || remainingPercent < existing.remainingPercent) {
			next = { ...next, remainingPercent };
		}
	}
	if (resetAt !== undefined) {
		if (next.resetAt === undefined || resetAt < next.resetAt) {
			next = { ...next, resetAt };
		}
	}
	if (next !== existing) {
		modelsByName.set(model, next);
	}
}

export function buildGoogleQuotaSnapshot(
	endpoint: string,
	projectId: string | undefined,
	modelsByName: Map<string, GoogleQuotaModelSnapshot>,
): GoogleQuotaAccountSnapshot {
	const models = [...modelsByName.values()];
	const remainingPercents = models
		.map((model) => model.remainingPercent)
		.filter((value): value is number => value !== undefined);
	const worstRemainingPercent = remainingPercents.length > 0
		? Math.min(...remainingPercents)
		: undefined;

	return {
		endpoint,
		projectId,
		models,
		worstRemainingPercent,
	};
}

export function getGoogleGeminiModelLabel(modelId: string | undefined): string {
	if (!modelId) return "unknown";
	const normalized = modelId.toLowerCase();
	if (normalized.includes("pro")) return "Pro";
	if (normalized.includes("flash")) return "Flash";
	return modelId;
}

export function parseGoogleGeminiQuotaSnapshot(
	data: unknown,
	projectId: string | undefined,
): GoogleQuotaAccountSnapshot {
	const raw = getRecord(data) as GoogleGeminiQuotaResponse | undefined;
	const buckets = Array.isArray(raw?.buckets) ? raw.buckets : [];
	const modelsByName = new Map<string, GoogleQuotaModelSnapshot>();

	for (const bucketValue of buckets) {
		const bucket = getRecord(bucketValue);
		const rawKey = typeof bucket?.modelId === "string" ? bucket.modelId : undefined;
		if (rawKey && (rawKey.toLowerCase().includes("placeholder") || rawKey.toLowerCase().startsWith("tab_"))) {
			continue;
		}
		const model = getGoogleGeminiModelLabel(rawKey);
		if (model.toLowerCase().includes("placeholder")) continue;
		const remainingPercent = normalizeGoogleRemainingPercent(bucket?.remainingFraction);
		const resetAt = typeof bucket?.resetTime === "string"
			? parseIsoTimestampSeconds(bucket.resetTime)
			: undefined;
		if (remainingPercent === undefined && resetAt === undefined) continue;
		updateGoogleQuotaModel(modelsByName, model, remainingPercent, resetAt, rawKey);
	}

	return buildGoogleQuotaSnapshot(GOOGLE_GEMINI_QUOTA_ENDPOINT, projectId, modelsByName);
}

export function isGoogleAntigravityPlaceholder(value: string | undefined): boolean {
	if (!value) return true;
	const lower = value.toLowerCase();
	return lower.includes("placeholder") || lower.startsWith("model_");
}

export function isGoogleAntigravityHiddenModel(modelKey: string, displayName?: string): boolean {
	const lowerKey = modelKey.toLowerCase();
	if (
		lowerKey.startsWith("tab_") ||
		lowerKey.startsWith("chat_") ||
		lowerKey.includes("placeholder") ||
		GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(lowerKey)
	) {
		return true;
	}
	if (displayName) {
		const lowerName = displayName.toLowerCase();
		if (
			lowerName.includes("placeholder") ||
			GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(lowerName)
		) {
			return true;
		}
	}
	return false;
}

export function formatAntigravityModelKey(key: string): string {
	const base = key.replace(/-tiered$/, "");
	try {
		const bundled = getModels("google-antigravity");
		const exact = bundled.find((m) => m.id === key);
		if (exact) return exact.name;
		const baseMatch = bundled.find((m) => m.id === base);
		if (baseMatch) return baseMatch.name;
	} catch {
		// Fall back to title-casing below
	}

	return base
		.split("-")
		.map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

export function parseGoogleAntigravityQuotaSnapshot(
	data: unknown,
	endpoint: string,
	projectId: string | undefined,
): GoogleQuotaAccountSnapshot {
	const raw = getRecord(data) as GoogleAntigravityQuotaResponse | undefined;
	const rawModels = getRecord(raw?.models);
	const modelsByName = new Map<string, GoogleQuotaModelSnapshot>();

	if (rawModels) {
		for (const [modelKey, modelValue] of Object.entries(rawModels)) {
			const model = getRecord(modelValue);
			if (model?.isInternal === true) continue;
			if (isGoogleAntigravityHiddenModel(modelKey)) continue;

			const rawDisplayName = typeof model?.displayName === "string" && model.displayName.length > 0
				? model.displayName
				: typeof model?.model === "string" && model.model.length > 0 && !isGoogleAntigravityPlaceholder(model.model)
					? model.model
					: undefined;

			const displayName = (rawDisplayName && !isGoogleAntigravityPlaceholder(rawDisplayName))
				? rawDisplayName
				: formatAntigravityModelKey(modelKey);

			if (isGoogleAntigravityHiddenModel(modelKey, displayName)) continue;

			const quotaInfo = getRecord(model?.quotaInfo);
			const remainingPercent = normalizeGoogleRemainingPercent(quotaInfo?.remainingFraction);
			const resetAt = typeof quotaInfo?.resetTime === "string"
				? parseIsoTimestampSeconds(quotaInfo.resetTime)
				: undefined;
			if (remainingPercent === undefined && resetAt === undefined) continue;
			updateGoogleQuotaModel(modelsByName, displayName, remainingPercent, resetAt, modelKey);
		}
	}

	return buildGoogleQuotaSnapshot(endpoint, projectId, modelsByName);
}

export function normalizeModelToken(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function stripCloneSuffix(name: string): string {
	return name.replace(/\s*\(#\d+\)\s*$/, "");
}

export function getGeminiFamily(model: { id: string; name: string }): "pro" | "flash" | undefined {
	const idNorm = normalizeModelToken(model.id);
	const nameNorm = normalizeModelToken(model.name);
	if (idNorm.includes("pro") || nameNorm.includes("pro")) return "pro";
	if (idNorm.includes("flash") || nameNorm.includes("flash")) return "flash";
	return undefined;
}

export function matchGoogleQuotaModels(
	baseProvider: string,
	model: { id: string; name: string },
	snapshot: GoogleQuotaAccountSnapshot,
): GoogleQuotaModelSnapshot[] {
	if (baseProvider === "google-gemini-cli") {
		const family = getGeminiFamily(model);
		if (!family) return [];
		return snapshot.models.filter((bucket) => bucket.model.toLowerCase() === family);
	}

	const mid = normalizeModelToken(model.id);
	const mname = normalizeModelToken(stripCloneSuffix(model.name));

	return snapshot.models.filter((bucket) => {
		const bkey = normalizeModelToken(bucket.key ?? "");
		const blabel = normalizeModelToken(bucket.model);

		if (bkey && mid && bkey === mid) return true;
		if (blabel && mname && blabel === mname) return true;

		if (bkey && mid && Math.min(bkey.length, mid.length) >= 4) {
			if (bkey.startsWith(mid) || mid.startsWith(bkey)) return true;
		}
		if (blabel && mname && Math.min(blabel.length, mname.length) >= 4) {
			if (blabel.startsWith(mname) || mname.startsWith(blabel)) return true;
		}

		return false;
	});
}

export function pickWorstQuotaModel(models: GoogleQuotaModelSnapshot[]): GoogleQuotaModelSnapshot | undefined {
	if (models.length === 0) return undefined;
	let worst = models[0];
	for (let i = 1; i < models.length; i++) {
		const current = models[i];
		const currentPercent = current.remainingPercent ?? 101;
		const worstPercent = worst.remainingPercent ?? 101;
		if (currentPercent < worstPercent) {
			worst = current;
		}
	}
	return worst;
}

export function classifyGoogleQuotaKind(snapshot: GoogleQuotaAccountSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	const bottleneck = snapshot.worstRemainingPercent;
	if (bottleneck === undefined) {
		return { kind: "error", score: 0 };
	}
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

export async function resolveGoogleQuotaAccess(
	account: QuotaAccount,
	auth: AuthStorageEntry,
	authStorage: AuthStorage,
	signal?: AbortSignal,
): Promise<{ accessToken: string; projectId?: string }> {
	const projectId = getGoogleProjectId(account, auth);
	const hasFreshAccess = typeof auth.access === "string"
		&& auth.access.length > 0
		&& (typeof auth.expires !== "number" || auth.expires > Date.now() + 60_000);
	if (hasFreshAccess) {
		return { accessToken: auth.access!, projectId };
	}

	const storage = adaptAuthStorage(authStorage);
	const access = await (typeof storage.getOAuthAccess === "function"
		? storage.getOAuthAccess(account.providerName, undefined, { signal })
		: undefined);
	if (!access) {
		throw new Error("Unable to refresh Google OAuth credentials. Log in again.");
	}
	return {
		accessToken: access.accessToken,
		projectId: access.projectId || projectId,
	};
}

export async function fetchGoogleGeminiQuotaSnapshot(
	accessToken: string,
	projectId: string | undefined,
	signal?: AbortSignal,
): Promise<GoogleQuotaAccountSnapshot> {
	const response = await fetch(GOOGLE_GEMINI_QUOTA_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			...GOOGLE_GEMINI_HEADERS,
		},
		body: "{}",
		signal,
	});
	if (!response.ok) {
		throw new Error(await readResponseError(response));
	}
	return parseGoogleGeminiQuotaSnapshot(await response.json(), projectId);
}

export async function fetchGoogleAntigravityQuotaSnapshot(
	accessToken: string,
	projectId: string | undefined,
	signal?: AbortSignal,
): Promise<GoogleQuotaAccountSnapshot> {
	let lastError = "Google quota lookup failed";

	for (const endpoint of GOOGLE_ANTIGRAVITY_QUOTA_ENDPOINTS) {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				...GOOGLE_ANTIGRAVITY_HEADERS,
			},
			body: JSON.stringify(projectId ? { project: projectId } : {}),
			signal,
		});
		if (response.ok) {
			return parseGoogleAntigravityQuotaSnapshot(await response.json(), endpoint, projectId);
		}
		lastError = await readResponseError(response);
	}

	throw new Error(lastError);
}

export function getGoogleQuotaBucketLabel(account: QuotaAccount, count: number): string {
	if (account.baseProvider === "google-gemini-cli") {
		return `${count} ${count === 1 ? "family" : "families"}`;
	}
	return `${count} ${count === 1 ? "model" : "models"}`;
}

export function buildGoogleQuotaErrorDetails(
	account: QuotaAccount,
	message: string,
	projectId?: string,
): string[] {
	const details = [
		`account: ${account.displayName}`,
		`provider: ${account.providerName}`,
		"status: error",
	];
	if (projectId) {
		details.push(`project: ${projectId}`);
	}
	details.push(`details: ${message}`);

	if (/401|unauthorized/i.test(message)) {
		details.push("login: use /multi-auth login or /login to authenticate this account again");
		return details;
	}

	if (/403|permission/i.test(message)) {
		if (account.baseProvider === "google-gemini-cli") {
			details.push(
				"hint: Google Cloud Code Assist rejected quota access for this account; try /multi-auth login again and verify this account still has Gemini quota access",
			);
		} else {
			details.push(
				"hint: Google rejected this Antigravity quota request; verify the saved project/account pairing is still valid and try /multi-auth login again",
			);
		}
	}

	return details;
}

export function formatGoogleQuotaDetails(
	account: QuotaAccount,
	snapshot: GoogleQuotaAccountSnapshot,
	kind: QuotaStatusKind,
	currentModel?: { id: string; name: string },
): string[] {
	const details = [
		`account: ${account.displayName}`,
		`provider: ${account.providerName}`,
		`status: ${formatQuotaKind(kind)}`,
	];
	if (snapshot.projectId) {
		details.push(`project: ${snapshot.projectId}`);
	}
	if (snapshot.worstRemainingPercent !== undefined) {
		details.push(`bottleneck: ${formatRemainingPercent(snapshot.worstRemainingPercent)} left`);
	}

	let currentModelLabels = new Set<string>();
	if (currentModel) {
		const matches = matchGoogleQuotaModels(account.baseProvider, currentModel, snapshot);
		const worst = pickWorstQuotaModel(matches);
		if (worst) {
			details.push(
				`current model (${worst.model}): ${formatRemainingPercent(worst.remainingPercent)} left, resets ${formatResetLong(worst.resetAt)}`,
			);
			currentModelLabels = new Set(matches.map((m) => m.model));
		} else {
			details.push(`current model (${currentModel.name}): not tracked by this provider`);
		}
	}

	for (const model of [...snapshot.models].sort((left, right) => {
		const leftPercent = left.remainingPercent ?? 101;
		const rightPercent = right.remainingPercent ?? 101;
		return leftPercent - rightPercent || left.model.localeCompare(right.model);
	})) {
		const suffix = currentModelLabels.has(model.model) ? "  ← current" : "";
		details.push(
			`${model.model}: ${formatRemainingPercent(model.remainingPercent)} left, resets ${formatResetLong(model.resetAt)}${suffix}`,
		);
	}
	details.push(`endpoint: ${snapshot.endpoint}`);
	return details;
}

export async function checkGoogleQuotaAccount(
	account: QuotaAccount,
	fetchSnapshot: (
		accessToken: string,
		projectId: string | undefined,
		signal?: AbortSignal,
	) => Promise<GoogleQuotaAccountSnapshot>,
	authStorage: AuthStorage,
	signal?: AbortSignal,
): Promise<QuotaCheckResult> {
	const auth = account.auth;
	if (!auth || auth.type !== "oauth") {
		return {
			account,
			kind: "missing-auth",
			summary: "not logged in",
			details: [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				"status: not logged in",
				"login: use /multi-auth login or /login to authenticate this account",
			],
			score: 0,
		};
	}
	if ((typeof auth.access !== "string" || auth.access.length === 0)
		&& (typeof auth.refresh !== "string" || auth.refresh.length === 0)) {
		return {
			account,
			kind: "missing-auth",
			summary: "missing Google tokens",
			details: [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				"status: not logged in",
				"details: saved Google credentials are missing both access and refresh tokens",
				"login: use /multi-auth login or /login to authenticate this account again",
			],
			score: 0,
		};
	}


	let projectId: string | undefined;

	try {
		const credentials = await resolveGoogleQuotaAccess(account, auth, authStorage, signal);
		projectId = credentials.projectId;
		const snapshot = await fetchSnapshot(credentials.accessToken, credentials.projectId, signal);
		if (snapshot.models.length === 0 || snapshot.worstRemainingPercent === undefined) {
			return {
				account,
				kind: "error",
				summary: "no model quota data returned",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					...(projectId ? [`project: ${projectId}`] : []),
					"details: Google returned no usable model quota data",
					`endpoint: ${snapshot.endpoint}`,
				],
				score: 0,
			};
		}

		const classification = classifyGoogleQuotaKind(snapshot);
		return {
			account,
			kind: classification.kind,
			summary: `${getGoogleQuotaBucketLabel(account, snapshot.models.length)} | bottleneck ${formatRemainingPercent(snapshot.worstRemainingPercent)} | ${formatQuotaKind(classification.kind)}`,
			details: formatGoogleQuotaDetails(account, snapshot, classification.kind),
			score: classification.score,
			googleSnapshot: snapshot,
		};
	} catch (error: unknown) {
		if (signal?.aborted || isAbortError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return {
			account,
			kind: "error",
			summary: message,
			details: buildGoogleQuotaErrorDetails(account, message, projectId),
			score: 0,
		};
	}
}

export function normalizeQuotaAllowedProviderNames(cwd: string): string[] | undefined {
	const project = loadProjectConfig(cwd);
	if (!project?.allowedSubs || project.allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(project.allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

export function collectQuotaAccounts(ctx: ExtensionContext, authStorage: AuthStorage): QuotaAccount[] {
	const storage = adaptAuthStorage(authStorage);
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allowedProviderNames = normalizeQuotaAllowedProviderNames(ctx.cwd);
	const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
	const seen = new Set<string>();
	const accounts: QuotaAccount[] = [];
	const pushAccount = (providerName: string, displayName: string) => {
		if (allowed && !allowed.has(providerName)) return;
		if (seen.has(providerName)) return;
		seen.add(providerName);
		accounts.push({
			providerName,
			baseProvider: getBaseProvider(providerName) || providerName,
			displayName,
			auth: storage.get(providerName) as AuthStorageEntry | undefined,
		});
	};

	for (const checker of PROVIDER_QUOTA_CHECKERS) {
		if (storage.hasAuth(checker.baseProvider)) {
			pushAccount(
				checker.baseProvider,
				PROVIDER_TEMPLATES[checker.baseProvider]?.displayName || checker.baseProvider,
			);
		}
		for (const entry of allSubs) {
			if (entry.provider !== checker.baseProvider) continue;
			pushAccount(subProviderName(entry), subDisplayName(entry));
		}
	}

	return accounts;
}

export const codexQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "openai-codex",
	async check(account: QuotaAccount, authStorage: AuthStorage, signal?: AbortSignal): Promise<QuotaCheckResult> {
		const auth = account.auth;
		if (!auth || auth.type !== "oauth" || typeof auth.access !== "string" || auth.access.length === 0) {
			return {
				account,
				kind: "missing-auth",
				summary: "not logged in",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: not logged in",
					"login: use /multi-auth login or /login to authenticate this account",
				],
				score: 0,
			};
		}

		const tokenMetadata = getCodexTokenMetadata(auth.access);
		const accountId = typeof auth.accountId === "string" && auth.accountId.length > 0
			? auth.accountId
			: tokenMetadata.accountId;
		const baseUrl = (process.env.CHATGPT_BASE_URL || DEFAULT_CODEX_USAGE_BASE_URL).replace(/\/+$/, "");
		const headers = new Headers({
			Authorization: `Bearer ${auth.access}`,
			Accept: "application/json",
			"User-Agent": "omp-multi-auth",
		});
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}

		try {
			const response = await fetch(`${baseUrl}/wham/usage`, {
				method: "GET",
				headers,
				signal,
			});
			if (!response.ok) {
				const error = await readResponseError(response);
				return {
					account,
					kind: "error",
					summary: error,
					details: [
						`account: ${account.displayName}`,
						`provider: ${account.providerName}`,
						`status: error`,
						`details: ${error}`,
					],
					score: 0,
				};
			}

			const snapshot = parseCodexUsageSnapshot(await response.json());
			if (!snapshot.email && tokenMetadata.email) snapshot.email = tokenMetadata.email;
			if ((!snapshot.planType || snapshot.planType === "unknown") && tokenMetadata.planType) {
				snapshot.planType = tokenMetadata.planType;
			}
			const fiveHourLeft = getCodexWindowRemaining(snapshot.fiveHour);
			const weeklyLeft = getCodexWindowRemaining(snapshot.weekly);
			const classification = classifyCodexQuotaKind(snapshot);
			const summary = [
				snapshot.planType !== "unknown" ? snapshot.planType : "plan unknown",
				`5h ${formatRemainingPercent(fiveHourLeft)} (${formatResetShort(snapshot.fiveHour?.resetAt)})`,
				`7d ${formatRemainingPercent(weeklyLeft)} (${formatResetShort(snapshot.weekly?.resetAt)})`,
				formatQuotaKind(classification.kind),
			].join(" | ");
			const details = [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				`status: ${formatQuotaKind(classification.kind)}`,
				`plan: ${snapshot.planType}`,
			];
			if (snapshot.email) {
				details.push(`email: ${snapshot.email}`);
			}
			details.push(
				`5-hour window: ${formatRemainingPercent(fiveHourLeft)} left, resets ${formatResetLong(snapshot.fiveHour?.resetAt)}`,
				`7-day window: ${formatRemainingPercent(weeklyLeft)} left, resets ${formatResetLong(snapshot.weekly?.resetAt)}`,
				`endpoint: ${baseUrl}/wham/usage`,
			);
			return {
				account,
				kind: classification.kind,
				summary,
				details,
				score: classification.score,
				codexSnapshot: snapshot,
			};
		} catch (error: unknown) {
			if (signal?.aborted || isAbortError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return {
				account,
				kind: "error",
				summary: message,
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					`details: ${message}`,
				],
				score: 0,
			};
		}
	},
};

export const googleGeminiCliQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "google-gemini-cli",
	async check(account: QuotaAccount, authStorage: AuthStorage, signal?: AbortSignal): Promise<QuotaCheckResult> {
		return checkGoogleQuotaAccount(account, fetchGoogleGeminiQuotaSnapshot, authStorage, signal);
	},
};

export const googleAntigravityQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "google-antigravity",
	async check(account: QuotaAccount, authStorage: AuthStorage, signal?: AbortSignal): Promise<QuotaCheckResult> {
		return checkGoogleQuotaAccount(account, fetchGoogleAntigravityQuotaSnapshot, authStorage, signal);
	},
};

export const PROVIDER_QUOTA_CHECKERS: ProviderQuotaChecker[] = [
	codexQuotaChecker,
	googleGeminiCliQuotaChecker,
	googleAntigravityQuotaChecker,
];

export async function showQuotaDetails(
	ctx: ExtensionCommandContext,
	result: QuotaCheckResult,
): Promise<void> {
	const details = (result.googleSnapshot && result.account.providerName === ctx.model?.provider && ctx.model)
		? formatGoogleQuotaDetails(result.account, result.googleSnapshot, result.kind, ctx.model)
		: result.details;

	await showWrappedSelect(ctx, {
		title: `Limit Details: ${result.account.displayName}`,
		subtitle: "Press Enter or Escape to go back to the limits list.",
		items: details.map((detail, index) => ({ value: `${index}:${detail}`, label: detail })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

export async function handleSubsLimits(ctx: ExtensionCommandContext): Promise<void> {
	const authStorage = getAuthStorage(ctx);
	const allowedProviderNames = normalizeQuotaAllowedProviderNames(ctx.cwd);
	const accounts = collectQuotaAccounts(ctx, authStorage);
	if (accounts.length === 0) {
		const suffix = allowedProviderNames && allowedProviderNames.length > 0
			? ` for this project restriction (${allowedProviderNames.join(", ")})`
			: "";
		ctx.ui.notify(
			`No supported subscription limits are available yet${suffix}. Login to a supported provider first.`,
			"info",
		);
		return;
	}

	const results = await loadQuotaResults(ctx, accounts, authStorage);
	if (!results) {
		ctx.ui.notify("Cancelled subscription limit check.", "info");
		return;
	}
	if (results.length === 0) {
		ctx.ui.notify("No supported quota checks matched the configured subscriptions.", "info");
		return;
	}

	let preferredProviderName = ctx.model?.provider;
	while (true) {
		const selected = await selectQuotaResult(ctx, results, preferredProviderName);
		if (!selected) return;
		preferredProviderName = selected.account.providerName;
		await showQuotaDetails(ctx, selected);
	}
}

export const QUOTA_STATUS_KEY = "multi-auth-quota";

export function formatCurrentModelQuota(
	result: QuotaCheckResult,
	model: { id: string; name: string; provider: string },
): string | undefined {
	if (result.kind === "missing-auth" || result.kind === "error") {
		return undefined;
	}

	if (result.googleSnapshot) {
		const matches = matchGoogleQuotaModels(result.account.baseProvider, model, result.googleSnapshot);
		const worst = pickWorstQuotaModel(matches);
		if (!worst) return undefined;
		return `${worst.model} ${formatRemainingPercent(worst.remainingPercent)} ${formatResetShort(worst.resetAt)}`;
	}

	if (result.codexSnapshot) {
		const s = result.codexSnapshot;
		const five = getCodexWindowRemaining(s.fiveHour);
		const week = getCodexWindowRemaining(s.weekly);
		let windowLabel: string | undefined;
		let remaining: number | undefined;
		let resetAt: number | undefined;

		if (five !== undefined && week !== undefined) {
			if (five <= week) {
				windowLabel = "5h";
				remaining = five;
				resetAt = s.fiveHour?.resetAt;
			} else {
				windowLabel = "7d";
				remaining = week;
				resetAt = s.weekly?.resetAt;
			}
		} else if (five !== undefined) {
			windowLabel = "5h";
			remaining = five;
			resetAt = s.fiveHour?.resetAt;
		} else if (week !== undefined) {
			windowLabel = "7d";
			remaining = week;
			resetAt = s.weekly?.resetAt;
		}

		if (windowLabel === undefined || remaining === undefined) return undefined;
		return `${windowLabel} ${formatRemainingPercent(remaining)} ${formatResetShort(resetAt)}`;
	}

	return undefined;
}

const statusQuotaCache = new Map<string, { at: number; result: QuotaCheckResult }>();
const statusQuotaInFlight = new Map<string, Promise<QuotaCheckResult | undefined>>();
export const STATUS_QUOTA_TTL_MS = 60_000;

export async function fetchStatusQuotaResult(
	ctx: ExtensionContext,
	providerName: string,
	baseProvider: string,
): Promise<QuotaCheckResult | undefined> {
	const inFlight = statusQuotaInFlight.get(providerName);
	if (inFlight) return inFlight;

	const fetchPromise = (async () => {
		try {
			const authStorage = getAuthStorage(ctx);
			const account: QuotaAccount = {
				providerName,
				baseProvider,
				displayName: providerName,
				auth: authStorage.get(providerName) as AuthStorageEntry | undefined,
			};
			const checker = PROVIDER_QUOTA_CHECKERS.find((c) => c.baseProvider === baseProvider);
			if (!checker) return undefined;
			const result = await checker.check(account, authStorage);
			statusQuotaCache.set(providerName, { at: Date.now(), result });
			return result;
		} catch {
			return undefined;
 		} finally {
			statusQuotaInFlight.delete(providerName);
		}
	})();

	statusQuotaInFlight.set(providerName, fetchPromise);
	return fetchPromise;
}

export function invalidateStatusQuota(providerName: string): void {
	statusQuotaCache.delete(providerName);
}

export function refreshQuotaStatusLine(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const model = ctx.model;
	if (!model) {
		ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const base = getBaseProvider(model.provider);
	if (!base || !PROVIDER_QUOTA_CHECKERS.some((c) => c.baseProvider === base)) {
		ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}

	const cached = statusQuotaCache.get(model.provider);
	if (cached) {
		ctx.ui.setStatus(QUOTA_STATUS_KEY, formatCurrentModelQuota(cached.result, model) ?? undefined);
	}
	if (!cached || Date.now() - cached.at > STATUS_QUOTA_TTL_MS) {
		fetchStatusQuotaResult(ctx, model.provider, base).then((result) => {
			if (!result) return;
			if (ctx.model?.provider === model.provider && ctx.model) {
				ctx.ui.setStatus(QUOTA_STATUS_KEY, formatCurrentModelQuota(result, ctx.model) ?? undefined);
			}
		});
	}
}

// ==========================================================================
// Config persistence (~/.omp/agent/multi-auth.json)
