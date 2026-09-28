// ========================================================================
// Config persistence and environment merge
// ========================================================================
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getModels, getAuthStorage, adaptAuthStorage, subProviderName, type SubEntry, type MultiAuthConfig, type ProjectConfig, type EffectiveConfig, type AuthStorageEntry, type AuthStorage } from "./core.ts";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { PROVIDER_TEMPLATES, SUPPORTED_PROVIDERS, getBaseProvider, subDisplayName } from "./providers.ts";

export function globalConfigPath(): string {
	return join(getAgentDir(), "multi-auth.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".omp", "multi-auth.json");
}

export function emptyMultiAuthConfig(): MultiAuthConfig {
	return { subscriptions: [], presets: [] };
}


export function normalizeMultiAuthConfig(raw: unknown): MultiAuthConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<MultiAuthConfig>) : {};
	return {
		subscriptions: Array.isArray(parsed.subscriptions) ? normalizeEntries(parsed.subscriptions) : [],
		presets: Array.isArray(parsed.presets) ? parsed.presets : [],
	};
}


export function normalizeProjectConfig(raw: unknown): ProjectConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<ProjectConfig>) : {};
	const config: ProjectConfig = {};
	if (Array.isArray(parsed.allowedSubs)) config.allowedSubs = parsed.allowedSubs;
	return config;
}

export function loadGlobalConfig(): MultiAuthConfig {
	const path = globalConfigPath();
	if (!existsSync(path)) return emptyMultiAuthConfig();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return normalizeMultiAuthConfig(raw);
	} catch {
		const config = emptyMultiAuthConfig();
		saveJsonConfig(path, config);
		return config;
	}
}

export function loadProjectConfig(cwd: string): ProjectConfig | undefined {
	const path = projectConfigPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		return normalizeProjectConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

export function normalizeAllowedProviderNames(allowedSubs: string[] | undefined): string[] | undefined {
	if (!allowedSubs || allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

export function loadEffectiveConfig(cwd: string): EffectiveConfig {
	const global = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const mergedSubscriptions = normalizeEntries(mergeConfigs(global, envEntries));
	const project = loadProjectConfig(cwd);

	if (!project) {
		return {
			subscriptions: mergedSubscriptions,
			presets: global.presets,
		};
	}

	const allowedProviderNames = normalizeAllowedProviderNames(project.allowedSubs);
	let subs = mergedSubscriptions;
	if (allowedProviderNames) {
		const allowed = new Set(allowedProviderNames);
		subs = mergedSubscriptions.filter((s) => allowed.has(subProviderName(s)));
	}

	return {
		subscriptions: subs,
		presets: global.presets,
		allowedProviderNames,
	};
}

export function saveJsonConfig(path: string, config: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	let backupPath: string | undefined;
	if (existsSync(path)) {
		try {
			JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			backupPath = `${path}.invalid-${Date.now()}-${process.pid}.bak`;
			copyFileSync(path, backupPath);
		}
	}

	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(config, null, 2), "utf-8");
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {}
		throw error;
	}

	if (backupPath) {
		console.warn(`[omp-multi-auth] Backed up malformed config to ${backupPath}`);
	}
}

export function saveGlobalConfig(config: MultiAuthConfig): void {
	saveJsonConfig(globalConfigPath(), config);
}

export function saveProjectConfig(cwd: string, config: ProjectConfig): void {
	saveJsonConfig(projectConfigPath(cwd), config);
}

export function getProviderDisplayName(providerName: string, subscriptions: SubEntry[]): string {
	const subEntry = subscriptions.find((entry) => subProviderName(entry) === providerName);
	if (subEntry) {
		return subDisplayName(subEntry);
	}
	return PROVIDER_TEMPLATES[providerName]?.displayName || providerName;
}

export function getProjectScopedProviderNames(
	ctx: ExtensionContext | ExtensionCommandContext,
	effective: EffectiveConfig,
): string[] {
	const seen = new Set<string>();
	const providerNames: string[] = [];
	const push = (providerName: string) => {
		if (!providerName || seen.has(providerName)) return;
		seen.add(providerName);
		providerNames.push(providerName);
	};

	if (effective.allowedProviderNames && effective.allowedProviderNames.length > 0) {
		for (const providerName of effective.allowedProviderNames) {
			const isExtraSubscription = effective.subscriptions.some(
				(entry) => subProviderName(entry) === providerName,
			);
			const isSupportedBaseProvider = SUPPORTED_PROVIDERS.includes(providerName);
			if (!isExtraSubscription && !isSupportedBaseProvider) continue;
			push(providerName);
		}
		return providerNames;
	}

	for (const providerName of SUPPORTED_PROVIDERS) {
		if (getAuthStorage(ctx).hasAuth(providerName)) {
			push(providerName);
		}
	}
	for (const entry of effective.subscriptions) {
		push(subProviderName(entry));
	}
	return providerNames;
}

export function findSelectableModelForProvider(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Model<Api> | undefined {
	if (!getAuthStorage(ctx).hasAuth(providerName)) {
		return undefined;
	}
	if (preferredModelId) {
		const preferred = ctx.modelRegistry.find(providerName, preferredModelId);
		if (preferred) {
			return preferred as Model<Api>;
		}
	}
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) {
		return undefined;
	}
	for (const baseModel of getModels(baseProvider as any) as Model<Api>[]) {
		const candidate = ctx.modelRegistry.find(providerName, baseModel.id);
		if (candidate) {
			return candidate as Model<Api>;
		}
	}
	return undefined;
}

export function formatAllowedProviderSummary(effective: EffectiveConfig): string | undefined {
	return effective.allowedProviderNames && effective.allowedProviderNames.length > 0
		? effective.allowedProviderNames.join(", ")
		: undefined;
}

// ==========================================================================
// Merge env var into config
// ==========================================================================

export function parseEnvConfig(): SubEntry[] {
	const raw = process.env.MULTI_SUB;
	if (!raw) return [];
	const entries: SubEntry[] = [];
	for (const part of raw.split(",")) {
		const [provider, countStr] = part.trim().split(":");
		if (!provider || !PROVIDER_TEMPLATES[provider]) continue;
		const count = parseInt(countStr || "1", 10);
		if (isNaN(count) || count < 1) continue;
		for (let i = 0; i < count; i++) {
			entries.push({ provider, index: 0 });
		}
	}
	return entries;
}

export function mergeConfigs(fileConfig: MultiAuthConfig, envEntries: SubEntry[]): SubEntry[] {
	const merged = [...fileConfig.subscriptions];
	for (const envEntry of envEntries) {
		const existingCount = merged.filter((s) => s.provider === envEntry.provider).length;
		const envCountForProvider = envEntries.filter((e) => e.provider === envEntry.provider).length;
		if (existingCount < envCountForProvider) {
			const usedIndices = merged
				.filter((s) => s.provider === envEntry.provider)
				.map((s) => s.index);
			let nextIndex = 2;
			while (usedIndices.includes(nextIndex)) nextIndex++;
			merged.push({ provider: envEntry.provider, index: nextIndex });
		}
	}
	return merged;
}

export function normalizeEntries(entries: SubEntry[]): SubEntry[] {
	const byProvider = new Map<string, SubEntry[]>();
	for (const entry of entries) {
		const list = byProvider.get(entry.provider) || [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}
	const result: SubEntry[] = [];
	for (const [, list] of byProvider) {
		const usedIndices = new Set(list.filter((e) => e.index > 0).map((e) => e.index));
		let nextIndex = 2;
		for (const entry of list) {
			if (entry.index > 0) {
				result.push(entry);
			} else {
				while (usedIndices.has(nextIndex)) nextIndex++;
				result.push({ ...entry, index: nextIndex });
				usedIndices.add(nextIndex);
				nextIndex++;
			}
		}
	}
	return result;
}

export function subAccountIdentifier(authStorage: AuthStorage, providerName: string): string | undefined {
	const storage = adaptAuthStorage(authStorage);
	const auth = storage.get(providerName) as AuthStorageEntry | undefined;
	for (const value of [auth?.email, auth?.accountId]) {
		if (typeof value !== "string") continue;
		const identifier = value.trim();
		if (identifier) return identifier;
	}
	return undefined;
}
export function formatSubscriptionStatus(entry: SubEntry, authStorage: AuthStorage): string {
	const storage = adaptAuthStorage(authStorage);
	const providerName = subProviderName(entry);
	if (!storage.hasAuth(providerName)) return "not logged in";
	const identifier = subAccountIdentifier(storage, providerName);
	return identifier ? `logged in ${identifier}` : "logged in";
}

export function getSubscriptionSource(config: MultiAuthConfig, entry: SubEntry): "config" | "env" {
	return config.subscriptions.find(
		(s) => s.provider === entry.provider && s.index === entry.index,
	)
		? "config"
		: "env";
}

export function formatSubscriptionMeta(
	entry: SubEntry,
	config: MultiAuthConfig,
	authStorage: AuthStorage,
): string {
	const storage = adaptAuthStorage(authStorage);
	const name = subProviderName(entry);
	const hasAuth = storage.hasAuth(name);
	const status = hasAuth ? "[logged in]" : "[not logged in]";
	const identifier = hasAuth ? subAccountIdentifier(storage, name) : undefined;
	const source = getSubscriptionSource(config, entry);
	return `${status}${identifier ? ` ${identifier}` : ""} (${source})`;
}

export function formatSubscriptionListLine(
	entry: SubEntry,
	config: MultiAuthConfig,
	authStorage: AuthStorage,
): string {
	return `${subDisplayName(entry)} -- ${formatSubscriptionMeta(entry, config, authStorage)}`;
}
