// Cross-module types and zero-dependency helpers.
import type { ExtensionCommandContext, ExtensionContext, AuthStorage as HostAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { getBundledModels, type GeneratedProvider } from "@oh-my-pi/pi-catalog";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { GoogleQuotaAccountSnapshot, CodexUsageSnapshot } from "./quota.ts";

export function getModels(providerId: string): Model<Api>[] {
	return getBundledModels(providerId as GeneratedProvider) as Model<Api>[];
}

export type QuotaStatusKind = "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth";

export interface AuthStorageEntry {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	[key: string]: unknown;
}

export interface MultiAuthStorage {
	hasAuth(providerName: string): boolean;
	get(providerName: string): AuthStorageEntry | undefined;
	logout(providerName: string): Promise<void>;
	remove?(providerName: string): Promise<void>;
	getOAuthAccess?(
		providerName: string,
		sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<{ accessToken: string; projectId?: string; [key: string]: unknown } | undefined>;
	[key: string]: unknown;
}

export type AuthStorage = (HostAuthStorage | MultiAuthStorage) & MultiAuthStorage;

export function adaptAuthStorage(raw: unknown): MultiAuthStorage {
	if (!raw || typeof raw !== "object") return raw as MultiAuthStorage;
	if ((raw as { __isAdapted?: boolean }).__isAdapted) return raw as MultiAuthStorage;

	const target = raw as Record<string, any>;
	const adapter: Record<string, any> = {
		__isAdapted: true,
		hasAuth(providerName: string): boolean {
			if (typeof target.hasAuth === "function") {
				return Boolean(target.hasAuth(providerName));
			}
			if (target.keys && typeof target.keys.source === "function") {
				if (target.keys.source(providerName) !== undefined) {
					return true;
				}
				if (typeof target.keys.keyless === "function" && target.keys.keyless(providerName)) {
					return true;
				}
			}
			if (target.credentials) {
				if (typeof target.credentials.has === "function" && target.credentials.has(providerName)) {
					return true;
				}
				if (typeof target.credentials.get === "function" && target.credentials.get(providerName) !== undefined) {
					return true;
				}
			}
			if (typeof target.has === "function" && target.has(providerName)) {
				return true;
			}
			if (typeof target.get === "function" && target.get(providerName) !== undefined) {
				return true;
			}
			return false;
		},
		get(providerName: string): AuthStorageEntry | undefined {
			let cred: any = undefined;
			if (typeof target.get === "function") {
				cred = target.get(providerName);
			} else if (target.credentials && typeof target.credentials.get === "function") {
				cred = target.credentials.get(providerName);
			}
			if (cred) {
				if (target.oauth && typeof target.oauth.identity === "function" && (!cred.email && !cred.accountId)) {
					try {
						const id = target.oauth.identity(providerName);
						if (id) {
							return {
								...cred,
								email: cred.email ?? id.email,
								accountId: cred.accountId ?? id.accountId,
							};
						}
					} catch {
						// ignore
					}
				}
				return cred;
			}
			if (target.oauth && typeof target.oauth.identity === "function") {
				try {
					const id = target.oauth.identity(providerName);
					if (id?.email || id?.accountId) {
						return {
							type: "oauth",
							email: id.email,
							accountId: id.accountId,
						};
					}
				} catch {
					// ignore
				}
			}
			return undefined;
		},
		async logout(providerName: string): Promise<void> {
			if (typeof target.logout === "function") {
				await target.logout(providerName);
				return;
			}
			if (target.credentials && typeof target.credentials.remove === "function") {
				await target.credentials.remove(providerName);
				return;
			}
			if (typeof target.remove === "function") {
				await target.remove(providerName);
				return;
			}
		},
		async remove(providerName: string): Promise<void> {
			if (typeof target.remove === "function") {
				await target.remove(providerName);
				return;
			}
			if (target.credentials && typeof target.credentials.remove === "function") {
				await target.credentials.remove(providerName);
				return;
			}
			if (typeof target.logout === "function") {
				await target.logout(providerName);
				return;
			}
		},
		async getOAuthAccess(providerName: string, sessionId?: string, options?: any) {
			if (typeof target.getOAuthAccess === "function") {
				return target.getOAuthAccess(providerName, sessionId, options);
			}
			if (target.oauth && typeof target.oauth.access === "function") {
				return target.oauth.access(providerName, sessionId, options);
			}
			return undefined;
		},
	};

	return new Proxy(target, {
		get(base, prop, receiver) {
			if (typeof prop === "string" && prop in adapter) {
				return adapter[prop];
			}
			const value = Reflect.get(base, prop, receiver);
			if (typeof value === "function") {
				return value.bind(base);
			}
			return value;
		},
	}) as MultiAuthStorage;
}

export function getAuthStorage(ctx: ExtensionContext | ExtensionCommandContext): AuthStorage {
	return adaptAuthStorage(ctx.modelRegistry?.authStorage) as AuthStorage;
}

export interface QuotaAccount {
	providerName: string;
	baseProvider: string;
	displayName: string;
	auth?: AuthStorageEntry;
}

export interface QuotaCheckResult {
	account: QuotaAccount;
	kind: QuotaStatusKind;
	summary: string;
	details: string[];
	score: number;
	googleSnapshot?: GoogleQuotaAccountSnapshot;
	codexSnapshot?: CodexUsageSnapshot;
}

export interface ProviderQuotaChecker {
	baseProvider: string;
	check(account: QuotaAccount, authStorage: AuthStorage, signal?: AbortSignal): Promise<QuotaCheckResult>;
}
export interface SubEntry {
	provider: string;
	index: number;
	label?: string;
}

/** A named routing preset that maps to an ordered list of provider+model entries. */
export interface PresetEntry {
	/** Provider name (e.g. "openai-codex", "anthropic-2") */
	provider: string;
	/** Model ID to use */
	model: string;
	/** Whether this entry is active */
	enabled: boolean;
}

export interface PresetConfig {
	/** Preset name (e.g. "coding-premium", "coding-budget") */
	name: string;
	/** Ordered provider+model entries to try */
	entries: PresetEntry[];
	/** Whether this preset is available */
	enabled: boolean;
}

export interface MultiAuthConfig {
	subscriptions: SubEntry[];
	presets: PresetConfig[];
}


/** Project-level config (.omp/multi-auth.json) */
export interface ProjectConfig {
	/** Restrict which provider names can be used in this project (for example
	 * "openai-codex" or "openai-codex-2"). If set, only these exact providers
	 * are available in this project. If not set, all global providers are available. */
	allowedSubs?: string[];
}

/** Effective config after merging global + project */
export interface EffectiveConfig {
	subscriptions: SubEntry[];
	presets: PresetConfig[];
	/** Exact provider names allowed in this project, if restricted. */
	allowedProviderNames?: string[];
}

export function subProviderName(entry: SubEntry): string {
	return `${entry.provider}-${entry.index}`;
}
