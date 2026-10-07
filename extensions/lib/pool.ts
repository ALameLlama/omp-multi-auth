import { createHash } from "node:crypto";
import type { Api, ApiKeyResolution, ApiKeyResolveContext, Model, SimpleStreamOptions, StoredAuthCredential, StoredCredentialBlock } from "@oh-my-pi/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { adaptAuthStorage, subProviderName } from "./core.ts";
import type { AuthStorage, AuthStorageEntry, EffectiveConfig, QuotaCheckResult } from "./core.ts";
import type * as ConfigModule from "./config.ts";
import type * as ProviderModule from "./providers.ts";

export const POOL_RESERVE_PERCENT = 15;
export const POOL_API_KEY = "omp-multi-auth-pool";
const QUOTA_PROBE_TIMEOUT_MS = 5_000;
const FAILURE_RECHECK_MS = 60_000;

type PoolContext = ExtensionContext | ExtensionCommandContext;
type Registry = ExtensionContext["modelRegistry"];
type RawAuthStorage = Registry["authStorage"];
type Resolver = Exclude<NonNullable<SimpleStreamOptions["apiKey"]>, string>;
type ResolveContext = ApiKeyResolveContext;
type Resolution = ApiKeyResolution;
type StoredRow = StoredAuthCredential;
type StoredBlock = StoredCredentialBlock;

/** One factory's immutable registry identity, assigned on its first session event. */
export interface PoolHostBinding {
	readonly registry?: Registry;
}

export function createPoolHostBinding(): PoolHostBinding {
	return {};
}

export function poolProviderName(baseProvider: string): string {
	return `${baseProvider}-pool`;
}

export interface PoolStatus {
	baseProvider: string;
	providerName: string;
	memberNames: string[];
	activeProviderName?: string;
	quota?: QuotaCheckResult;
}

interface SessionBinding {
	id: string;
	registry: Registry;
	raw: RawAuthStorage;
	manager: PoolContext["sessionManager"];
	preferred?: string;
	/** Physical provider explicitly pinned by the user; suppresses pool promotion. */
	pinned?: string;
	notify: PoolContext["ui"]["notify"];
	refreshStatus?: () => void;
}

interface CredentialState {
	identity: string;
	fingerprint: string;
	providers: Set<string>;
	failures: Map<string, number>;
	quota?: QuotaCheckResult;
	probe?: Promise<QuotaCheckResult | undefined>;
}

interface PoolScope {
	activeProviderName?: string;
	activeIdentity?: string;
	version: number;
	lock: Promise<void>;
}

interface Coordinator {
	generation: number;
	credentials: Map<string, CredentialState>;
	scopes: Map<string, PoolScope>;
}

interface RoutingPolicy {
	binding: SessionBinding;
	requester?: SessionBinding;
	effective: EffectiveConfig;
	allowedNames: string[];
	policyKey: string;
}

interface RequestMember {
	name: string;
	model: Model<Api>;
	resolver: Resolver;
	resolved: Resolution;
	state: CredentialState;
	row?: StoredRow;
	remaining?: number;
}

interface SharedPoolState {
	readonly sessions: Map<string, SessionBinding>;
	readonly coordinators: WeakMap<RawAuthStorage, Coordinator>;
}

// OMP cache-busts each extension's entire local ESM graph with a distinct
// ?mtime tag. Root/child factories and other importing extensions therefore
// need the same process-owned state even when pool.ts has multiple instances.
// This extension-owned symbol holds services/coordinators only, never tokens
// or a mutable latest context. Registry identity still isolates ownership.
const poolStateKey = Symbol.for("omp-multi-auth.subscription-pool-state");
const poolGlobal = globalThis as typeof globalThis & { [poolStateKey]?: SharedPoolState };
const sharedPoolState = poolGlobal[poolStateKey] ??= {
	sessions: new Map<string, SessionBinding>(),
	coordinators: new WeakMap<RawAuthStorage, Coordinator>(),
};
const sessions = sharedPoolState.sessions;
const coordinators = sharedPoolState.coordinators;
// These modules depend on providers.ts, which imports this module for its stream.
// Load them only after registration; there is no circular runtime initialization.
let routingHelpers: { config: typeof ConfigModule; providers: typeof ProviderModule } | undefined;
let routingLoad: Promise<NonNullable<typeof routingHelpers>> | undefined;
function loadRoutingHelpers(): Promise<NonNullable<typeof routingHelpers>> {
	return routingLoad ??= Promise.all([import("./config.ts"), import("./providers.ts")]).then(([config, providers]) => {
		return routingHelpers = { config, providers };
	});
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function rowFingerprint(row: StoredRow): string {
	return digest(JSON.stringify([row.provider, row.disabledCause, row.credential]));
}

function clearActiveIdentity(coordinator: Coordinator, identity: string, retainProvider = false): void {
	for (const scope of coordinator.scopes.values()) {
		if (scope.activeIdentity !== identity) continue;
		if (!retainProvider) scope.activeProviderName = undefined;
		scope.activeIdentity = undefined;
		scope.version++;
	}
}

function synchronizeCredentials(raw: RawAuthStorage, coordinator: Coordinator): void {
	const generation = raw.credentials.generation;
	if (generation === coordinator.generation) return;
	coordinator.generation = generation;
	const rows = new Map(raw.credentials.list().map(row => [`row:${row.id}`, row]));
	for (const [identity, state] of coordinator.credentials) {
		if (!identity.startsWith("row:")) continue;
		const row = rows.get(identity);
		if (row && !row.disabledCause && state.fingerprint === rowFingerprint(row)) continue;
		coordinator.credentials.delete(identity);
		clearActiveIdentity(coordinator, identity, Boolean(row && !row.disabledCause));
	}
}

function getCoordinator(raw: RawAuthStorage): Coordinator {
	let coordinator = coordinators.get(raw);
	if (!coordinator) {
		coordinator = { generation: raw.credentials.generation, credentials: new Map(), scopes: new Map() };
		coordinators.set(raw, coordinator);
		// A native credential reload/login/logout invalidates just the identities
		// that changed. An outstanding request still owns its native resolver.
		raw.credentials.onGeneration(() => synchronizeCredentials(raw, coordinator!));
	}
	synchronizeCredentials(raw, coordinator);
	return coordinator;
}

export function bindPoolSession(ctx: PoolContext, host: PoolHostBinding): void {
	if (host.registry && host.registry !== ctx.modelRegistry) {
		throw new Error("multi-auth: subscription pool host registry changed.");
	}
	if (!host.registry) Object.defineProperty(host, "registry", { value: ctx.modelRegistry, enumerable: true });
	const id = ctx.sessionManager.getSessionId();
	const previous = sessions.get(id);
	if (previous && previous.registry !== ctx.modelRegistry) {
		throw new Error("multi-auth: subscription pool session registry changed.");
	}
	sessions.set(id, {
		id,
		registry: ctx.modelRegistry,
		raw: ctx.modelRegistry.authStorage,
		manager: ctx.sessionManager,
		preferred: previous?.preferred ?? (ctx.model?.provider.endsWith("-pool") ? undefined : ctx.model?.provider),
		pinned: previous?.pinned,
		notify: ctx.ui.notify.bind(ctx.ui),
		refreshStatus: previous?.refreshStatus,
	});
	getCoordinator(ctx.modelRegistry.authStorage);
}

export function unbindPoolSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** This is an initial preference, never an account pin or shared-active reset. */
export function preferPoolMember(ctx: PoolContext, providerName: string): void {
	const binding = sessions.get(ctx.sessionManager.getSessionId());
	if (binding?.registry === ctx.modelRegistry && !providerName.endsWith("-pool")) binding.preferred = providerName;
}

/** Pin this session to one physical provider (no pool promotion) or clear the pin. */
export function pinPoolMember(ctx: PoolContext, providerName: string | undefined): void {
	const binding = sessions.get(ctx.sessionManager.getSessionId());
	if (binding?.registry === ctx.modelRegistry) {
		binding.pinned = providerName && !providerName.endsWith("-pool") ? providerName : undefined;
	}
}

export function getPoolMemberPin(ctx: PoolContext): string | undefined {
	const binding = sessions.get(ctx.sessionManager.getSessionId());
	return binding?.registry === ctx.modelRegistry ? binding.pinned : undefined;
}

export function setPoolStatusCallback(ctx: PoolContext, callback: (() => void) | undefined): void {
	const binding = sessions.get(ctx.sessionManager.getSessionId());
	if (binding?.registry === ctx.modelRegistry) binding.refreshStatus = callback;
}

/** Logout/removal evicts future routing state, without touching an open stream. */
export function evictPoolMember(raw: RawAuthStorage, providerName: string): void {
	const coordinator = coordinators.get(raw);
	if (!coordinator) return;
	for (const [identity, state] of coordinator.credentials) {
		if (!state.providers.has(providerName)) continue;
		coordinator.credentials.delete(identity);
		clearActiveIdentity(coordinator, identity);
	}
	for (const scope of coordinator.scopes.values()) {
		if (scope.activeProviderName !== providerName) continue;
		scope.activeProviderName = undefined;
		scope.activeIdentity = undefined;
		scope.version++;
	}
}


function policyFor(binding: SessionBinding, cwd: string, requester?: SessionBinding): RoutingPolicy {
	const { config, providers } = routingHelpers!;
	const effective = config.loadEffectiveConfig(cwd);
	const permitted = config.getProjectScopedProviderNames({ modelRegistry: binding.registry, cwd } as PoolContext, effective);
	// Include unauthenticated canonical names in the policy identity so logout
	// does not accidentally turn two distinct project policies into one scope.
	if (!effective.allowedProviderNames) permitted.push(...providers.SUPPORTED_PROVIDERS);
	const allowedNames = [...new Set(permitted)].filter(name => !name.endsWith("-pool") && providers.getBaseProvider(name));
	return { binding, requester, effective, allowedNames, policyKey: JSON.stringify([...allowedNames].sort()) };
}


function resolveOwnership(host: PoolHostBinding, options: SimpleStreamOptions): RoutingPolicy {
	const registry = host.registry;
	if (!registry) throw new Error("multi-auth: missing session context for subscription pool.");
	const findSession = (id: string | undefined): SessionBinding | undefined => {
		if (!id) return undefined;
		const binding = sessions.get(id);
		return binding?.registry === registry ? binding : undefined;
	};
	let owner = findSession(options.sessionId);
	// v18.6.2 creates `${cacheSessionId}:side:...`; no other inferred lineage.
	if (!owner && options.sessionId) {
		const parentEnd = options.sessionId.indexOf(":side:");
		if (parentEnd !== -1) owner = findSession(options.sessionId.slice(0, parentEnd));
	}
	const live = [...sessions.values()].filter(binding => binding.registry === registry);
	if (!owner && options.promptCacheKey) {
		const matches = live.filter(binding => binding.id === options.promptCacheKey
			|| (binding.manager.getHeader()?.providerPromptCacheKey ?? binding.id) === options.promptCacheKey);
		if (matches.length === 1) owner = matches[0];
		else if (matches.length > 1) {
			const policies = matches.map(binding => policyFor(binding, options.cwd ?? binding.manager.getCwd()));
			if (new Set(policies.map(policy => policy.policyKey)).size === 1) return policies[0];
			throw new Error("multi-auth: missing session context for subscription pool.");
		}
	}
	if (owner) return policyFor(owner, options.cwd ?? owner.manager.getCwd(), owner);
	// Native title/summary calls can have unrelated/absent IDs and no cwd.
	// A representative supplies services, not an arbitrary notification owner.
	if (options.cwd === undefined && live.length > 0) {
		const policies = live.map(binding => policyFor(binding, binding.manager.getCwd()));
		if (new Set(policies.map(policy => policy.policyKey)).size === 1) return policies[0];
	}
	throw new Error("multi-auth: missing session context for subscription pool.");
}

function currentPolicy(policy: RoutingPolicy, options: SimpleStreamOptions): RoutingPolicy {
	return policyFor(policy.binding, options.cwd ?? policy.binding.manager.getCwd(), policy.requester);
}

function familyAllowedNames(policy: RoutingPolicy, baseProvider: string): string[] {
	return policy.allowedNames.filter(name => routingHelpers!.providers.getBaseProvider(name) === baseProvider);
}

function enumerateMembers(policy: RoutingPolicy, baseProvider: string, modelId: string): string[] {
	const permitted = new Set(familyAllowedNames(policy, baseProvider));
	const storage = adaptAuthStorage(policy.binding.raw);
	return [baseProvider, ...policy.effective.subscriptions.map(subProviderName)].filter((name, index, all) => {
		return all.indexOf(name) === index && permitted.has(name) && !name.endsWith("-pool")
			&& routingHelpers!.providers.getBaseProvider(name) === baseProvider
			&& storage.hasAuth(name) && Boolean(policy.binding.registry.find(name, modelId));
	});
}

/** Exact-model authenticated physical membership; global ignores allowedSubs. */
export async function listPoolMemberNames(ctx: PoolContext, baseProvider: string, modelId: string, global = false): Promise<string[]> {
	await loadRoutingHelpers();
	const bound = sessions.get(ctx.sessionManager.getSessionId());
	const binding = bound?.registry === ctx.modelRegistry ? bound : {
		id: ctx.sessionManager.getSessionId(), registry: ctx.modelRegistry, raw: ctx.modelRegistry.authStorage,
		manager: ctx.sessionManager, notify: ctx.ui.notify.bind(ctx.ui),
	};
	const policy = policyFor(binding, ctx.sessionManager.getCwd());
	if (global) {
		const config = routingHelpers!.config;
		const globalConfig = config.loadGlobalConfig();
		policy.effective = { ...globalConfig, subscriptions: config.normalizeEntries(config.mergeConfigs(globalConfig, config.parseEnvConfig())) };
		policy.allowedNames = [...routingHelpers!.providers.SUPPORTED_PROVIDERS, ...policy.effective.subscriptions.map(subProviderName)];
	}
	return enumerateMembers(policy, baseProvider, modelId);
}

function getScope(coordinator: Coordinator, policy: RoutingPolicy, baseProvider: string): PoolScope {
	const allowedNames = familyAllowedNames(policy, baseProvider).sort();
	const key = JSON.stringify([baseProvider, allowedNames]);
	let scope = coordinator.scopes.get(key);
	if (!scope) {
		scope = { version: 0, lock: Promise.resolve() };
		coordinator.scopes.set(key, scope);
	}
	return scope;
}

export function getPoolStatus(ctx: PoolContext): PoolStatus | undefined {
	const providerName = ctx.model?.provider;
	if (!providerName?.endsWith("-pool") || !routingHelpers) return undefined;
	const baseProvider = providerName.slice(0, -"-pool".length);
	if (!routingHelpers.providers.SUPPORTED_PROVIDERS.includes(baseProvider)) return undefined;
	const binding = sessions.get(ctx.sessionManager.getSessionId());
	if (!binding || binding.registry !== ctx.modelRegistry) return undefined;
	const policy = policyFor(binding, binding.manager.getCwd(), binding);
	const coordinator = getCoordinator(binding.raw);
	const scope = getScope(coordinator, policy, baseProvider);
	const memberNames = enumerateMembers(policy, baseProvider, ctx.model!.id);
	const activeProviderName = scope.activeProviderName && memberNames.includes(scope.activeProviderName) ? scope.activeProviderName : undefined;
	const quota = activeProviderName && scope.activeIdentity ? coordinator.credentials.get(scope.activeIdentity)?.quota : undefined;
	return { baseProvider, providerName, memberNames, activeProviderName, quota };
}

function checkCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Cancel this waiter, not the shared quota probe or another caller's lock. */
async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	checkCancelled(signal);
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function withScopeLock<T>(scope: PoolScope, signal: AbortSignal | undefined, action: () => T): Promise<T> {
	const previous = scope.lock;
	let release!: () => void;
	scope.lock = new Promise<void>(resolve => { release = resolve; });
	try {
		await cancellable(previous, signal);
		checkCancelled(signal);
		return action();
	} finally {
		// If a queued caller aborts, its successor must still wait for the
		// predecessor: never release a hole in the selection queue early.
		void previous.then(release, release);
	}
}

function bearer(resolved: Resolution): string | undefined {
	return typeof resolved === "string" ? resolved || undefined : resolved?.apiKey || undefined;
}

function resolvedId(resolved: Resolution): number | undefined {
	return typeof resolved === "object" ? resolved?.credentialId : undefined;
}

function credentialState(raw: RawAuthStorage, coordinator: Coordinator, providerName: string, resolved: Resolution): { state: CredentialState; row?: StoredRow } {
	const id = resolvedId(resolved);
	const row = id === undefined ? undefined : raw.credentials.list(providerName).find(row => row.id === id && !row.disabledCause);
	const identity = id === undefined ? `external:${providerName}:${digest(bearer(resolved)!)}` : `row:${id}`;
	const fingerprint = row ? rowFingerprint(row) : digest(bearer(resolved)!);
	let state = coordinator.credentials.get(identity);
	if (state && state.fingerprint !== fingerprint) {
		coordinator.credentials.delete(identity);
		clearActiveIdentity(coordinator, identity, true);
		state = undefined;
	}
	// Rowless override replacement/logout never keeps an earlier key's state.
	if (id === undefined) {
		for (const [oldIdentity, oldState] of coordinator.credentials) {
			if (oldIdentity === identity || !oldIdentity.startsWith(`external:${providerName}:`)) continue;
			coordinator.credentials.delete(oldIdentity);
			clearActiveIdentity(coordinator, oldState.identity);
		}
	}
	if (!state) {
		state = { identity, fingerprint, providers: new Set(), failures: new Map() };
		coordinator.credentials.set(identity, state);
	}
	state.providers.add(providerName);
	return { state, row };
}

function blocksFor(raw: RawAuthStorage, resolved: Resolution): StoredBlock[] {
	const id = resolvedId(resolved);
	return id === undefined ? [] : raw.blocks.list([id]).filter(block => block.blockedUntilMs > Date.now());
}

function unavailable(raw: RawAuthStorage, member: RequestMember, modelId: string): boolean {
	const model = modelId.toLowerCase();
	const failure = member.state.failures.get(model);
	if (failure !== undefined) {
		if (failure > Date.now()) return true;
		member.state.failures.delete(model);
	}
	// A native block marks this credential unusable unless its scope is a
	// model-specific policy for a different model. OMP uses provider-owned
	// scopes for rate limits (Codex: "chat"/"spark"/"shared") alongside the
	// generic "auth"/"account-policy" scopes; all of them must park the account.
	// Only `model-policy:<id>` is per-model, and only blocks the requested model.
	return blocksFor(raw, member.resolved).some(block => {
		const scope = block.blockScope;
		if (!scope) return true;
		if (scope.startsWith("model-policy:")) return scope === `model-policy:${model}`;
		return true;
	});
}

function memberCurrent(policy: RoutingPolicy, baseProvider: string, modelId: string, member: RequestMember): boolean {
	if (!enumerateMembers(policy, baseProvider, modelId).includes(member.name)) return false;
	if (policy.binding.registry.find(member.name, modelId) !== member.model) return false;
	if (resolvedId(member.resolved) === undefined) return true;
	return policy.binding.raw.credentials.list(member.name).some(row => row.id === resolvedId(member.resolved)
		&& !row.disabledCause && rowFingerprint(row) === member.state.fingerprint);
}

async function quotaFor(raw: RawAuthStorage, coordinator: Coordinator, baseProvider: string, member: RequestMember, signal?: AbortSignal): Promise<void> {
	// Runtime/config/env keys carry no durable row. Never borrow a stored
	// account merely because the provider also has an OAuth credential.
	if (!member.row) return;
	// Static initialization would close providers → pool → quota → providers.
	const quota = await import("./quota.ts");
	checkCancelled(signal);
	const checker = quota.PROVIDER_QUOTA_CHECKERS.find(checker => checker.baseProvider === baseProvider);
	if (!checker) return;
	const state = member.state;
	if (!state.probe) {
		const controller = new AbortController();
		let finishTimeout!: () => void;
		const timeout = new Promise<undefined>(resolve => { finishTimeout = () => resolve(undefined); });
		const timer = setTimeout(() => {
			controller.abort(new DOMException("Quota probe timed out.", "TimeoutError"));
			finishTimeout();
		}, QUOTA_PROBE_TIMEOUT_MS);
		const auth = member.row.credential as AuthStorageEntry;
		const account = { providerName: member.name, baseProvider, displayName: member.name, auth };
		// Native resolution already refreshed this exact row. The checker must
		// not invoke a provider-level refresh that could pick a different row.
		const selectedStorage = new Proxy(adaptAuthStorage(raw), {
			get(target, property, receiver) {
				if (property === "getOAuthAccess") return async () => typeof auth.access === "string"
					? { accessToken: auth.access, projectId: auth.projectId } : undefined;
				return Reflect.get(target, property, receiver);
			},
		}) as AuthStorage;
		const work = checker.check(account, selectedStorage, controller.signal).catch(() => undefined);
		const probe = Promise.race([work, timeout]).then(result => {
			// Status snapshots must not become another credential store.
			const snapshot = result ? { ...result, account: { providerName: member.name, baseProvider, displayName: member.name } } : undefined;
			if (coordinator.credentials.get(state.identity) === state) state.quota = snapshot;
			return snapshot;
		}).finally(() => {
			clearTimeout(timer);
			if (state.probe === probe) state.probe = undefined;
		});
		state.probe = probe;
	}
	const result = await cancellable(state.probe, signal);
	checkCancelled(signal);
	if (result?.codexSnapshot) {
		const remaining = [quota.getCodexWindowRemaining(result.codexSnapshot.fiveHour), quota.getCodexWindowRemaining(result.codexSnapshot.weekly)]
			.filter((value): value is number => value !== undefined && Number.isFinite(value));
		member.remaining = remaining.length ? Math.min(...remaining) : undefined;
	} else if (result?.googleSnapshot) {
		const remaining = quota.pickWorstQuotaModel(quota.matchGoogleQuotaModels(baseProvider, member.model, result.googleSnapshot))?.remainingPercent;
		member.remaining = remaining !== undefined && Number.isFinite(remaining) ? remaining : undefined;
	}
}

function rankMembers(members: RequestMember[], active: string | undefined, preferred: string | undefined): RequestMember | undefined {
	const category = (member: RequestMember) => member.remaining === undefined ? 1 : member.remaining > POOL_RESERVE_PERCENT ? 2 : 0;
	return members.reduce<RequestMember | undefined>((best, member) => {
		if (!best) return member;
		const difference = category(member) - category(best);
		if (difference !== 0) return difference > 0 ? member : best;
		if (member.remaining !== undefined && best.remaining !== undefined && member.remaining !== best.remaining) {
			return member.remaining > best.remaining ? member : best;
		}
		if ((member.name === active) !== (best.name === active)) return member.name === active ? member : best;
		if ((member.name === preferred) !== (best.name === preferred)) return member.name === preferred ? member : best;
		return best;
	}, undefined);
}

function recordFailure(raw: RawAuthStorage, member: RequestMember, modelId: string, before: StoredBlock[]): void {
	const old = new Map(before.map(block => [`${block.providerKey}\0${block.blockScope}`, block]));
	const deadlines = blocksFor(raw, member.resolved).filter(block => {
		const prior = old.get(`${block.providerKey}\0${block.blockScope}`);
		return !prior || prior.blockedUntilMs !== block.blockedUntilMs || prior.updatedAtMs !== block.updatedAtMs;
	}).map(block => block.blockedUntilMs);
	member.state.failures.set(modelId.toLowerCase(), deadlines.length ? Math.max(...deadlines) : Date.now() + FAILURE_RECHECK_MS);
	member.state.quota = undefined;
}

export function createPoolResolver(
	host: PoolHostBinding,
	baseProvider: string,
	modelId: string,
	options: SimpleStreamOptions,
	onSelected: (memberModel: Model<Api>) => void,
): Resolver {
	// All attempt state belongs to this logical request, not its session/scope.
	let policy: RoutingPolicy | undefined;
	let current: RequestMember | undefined;
	const attemptedMembers = new Set<string>();
	const attemptedCredentials = new Set<string>();
	const refreshRequestPolicy = (): RoutingPolicy => {
		// Ownership is retained by a running request after shutdown. Before its
		// first dispatch, an auxiliary request must still recheck live policies.
		const hasLiveBinding = [...sessions.values()].some(binding => binding.registry === policy!.binding.registry);
		return policy!.requester || current || !hasLiveBinding
			? currentPolicy(policy!, options) : resolveOwnership(host, options);
	};

	const select = async (context: ResolveContext, reason: "headroom" | "limit"): Promise<Resolution> => {
		const signal = context.signal ?? options.signal;
		checkCancelled(signal);
		await loadRoutingHelpers();
		checkCancelled(signal);
		policy ??= resolveOwnership(host, options);
		const raw = policy.binding.raw;
		const coordinator = getCoordinator(raw);
		for (;;) {
			checkCancelled(signal);
			policy = refreshRequestPolicy();
			const scope = getScope(coordinator, policy, baseProvider);
			const names = enumerateMembers(policy, baseProvider, modelId).filter(name => !attemptedMembers.has(name));
			const membershipKey = JSON.stringify(names);
			if (names.length === 0) {
				if (!current && attemptedMembers.size === 0) throw new Error(`multi-auth: no authenticated allowed pool members for ${baseProvider}/${modelId}.`);
				return undefined;
			}
			const snapshot = await withScopeLock(scope, signal, () => ({ active: scope.activeProviderName, identity: scope.activeIdentity, version: scope.version }));
			const preferred = policy.requester?.preferred;
			const first = names.includes(snapshot.active!) ? snapshot.active! : names.includes(preferred!) ? preferred! : names[0];
			const resolvedMembers = new Map<string, RequestMember | undefined>();
			const resolveMember = async (name: string): Promise<RequestMember | undefined> => {
				if (resolvedMembers.has(name)) return resolvedMembers.get(name);
				const model = policy!.binding.registry.find(name, modelId) as Model<Api> | undefined;
				if (!model) return undefined;
				const resolver = raw.keys.resolver(name, { sessionId: options.sessionId, baseUrl: model.baseUrl, modelId });
				let resolved: Resolution;
				try {
					resolved = await resolver({ lastChance: false, error: undefined, signal });
				} catch {
					checkCancelled(signal);
					resolvedMembers.set(name, undefined);
					return undefined;
				}
				checkCancelled(signal);
				if (!bearer(resolved) || bearer(resolved) === POOL_API_KEY) {
					resolvedMembers.set(name, undefined);
					return undefined;
				}
				const member: RequestMember = { name, model, resolver, resolved, ...credentialState(raw, coordinator, name, resolved) };
				if (!unavailable(raw, member, modelId)) await quotaFor(raw, coordinator, baseProvider, member, signal);
				resolvedMembers.set(name, member);
				return member;
			};
			// Probes and credential refreshes are outside the short selection lock.
			const firstMember = await resolveMember(first);
			let selected = firstMember && !unavailable(raw, firstMember, modelId)
				&& (firstMember.remaining === undefined || firstMember.remaining > POOL_RESERVE_PERCENT) ? firstMember : undefined;
			if (!selected) {
				const alternatives = await Promise.all(names.filter(name => name !== first).map(resolveMember));
				selected = rankMembers([firstMember, ...alternatives].filter((member): member is RequestMember => Boolean(member) && !unavailable(raw, member!, modelId)), snapshot.active, preferred);
			}
			checkCancelled(signal);
			getCoordinator(raw);
			const livePolicy = refreshRequestPolicy();
			if (getScope(coordinator, livePolicy, baseProvider) !== scope) { policy = livePolicy; continue; }
			if (JSON.stringify(enumerateMembers(livePolicy, baseProvider, modelId).filter(name => !attemptedMembers.has(name))) !== membershipKey) continue;
			if (selected && (!memberCurrent(livePolicy, baseProvider, modelId, selected) || unavailable(raw, selected, modelId))) continue;
			let old: string | undefined;
			const committed = await withScopeLock(scope, signal, () => {
				if (scope.version !== snapshot.version) return false;
				const recheckedPolicy = refreshRequestPolicy();
				if (getScope(coordinator, recheckedPolicy, baseProvider) !== scope) return false;
				if (JSON.stringify(enumerateMembers(recheckedPolicy, baseProvider, modelId).filter(name => !attemptedMembers.has(name))) !== membershipKey) return false;
				if (selected && (!memberCurrent(recheckedPolicy, baseProvider, modelId, selected) || unavailable(raw, selected, modelId))) return false;
				if (!selected) return true;
				old = scope.activeProviderName;
				scope.activeProviderName = selected.name;
				scope.activeIdentity = selected.state.identity;
				if (old !== selected.name || snapshot.identity !== selected.state.identity) scope.version++;
				return true;
			});
			if (!committed) continue;
			if (!selected) return undefined;
			current = selected;
			attemptedMembers.add(selected.name);
			attemptedCredentials.add(selected.state.identity);
			onSelected(selected.model);
			try {
				if (policy.requester && old && old !== selected.name) {
					policy.requester.notify(`multi-auth: ${old} → ${selected.name} (${reason === "limit" ? "account limit" : `${POOL_RESERVE_PERCENT}% headroom`}).`, "info");
				}
				policy.requester?.refreshStatus?.();
			} catch {
				// An unavailable UI must not suppress an authenticated dispatch.
			}
			return selected.resolved;
		}
	};

	return async context => {
		const signal = context.signal ?? options.signal;
		checkCancelled(signal);
		if (!current || context.error === undefined) return select(context, "headroom");
		const failing = current;
		const before = context.lastChance ? blocksFor(policy!.binding.raw, failing.resolved) : [];
		let resolved: Resolution = undefined;
		try {
			// Preserve the host's actual failed bearer, error and cancellation signal.
			resolved = await failing.resolver(context);
		} catch (error) {
			checkCancelled(signal);
			if (!context.lastChance) throw error;
		} finally {
			if (context.lastChance) recordFailure(policy!.binding.raw, failing, modelId, before);
		}
		checkCancelled(signal);
		if (!context.lastChance) {
			if (bearer(resolved) && bearer(resolved) !== POOL_API_KEY) {
				const refreshed = { ...failing, resolved, ...credentialState(policy!.binding.raw, getCoordinator(policy!.binding.raw), failing.name, resolved) };
				const livePolicy = refreshRequestPolicy();
				if (!memberCurrent(livePolicy, baseProvider, modelId, refreshed)) return undefined;
				const coordinator = getCoordinator(policy!.binding.raw);
				const scope = getScope(coordinator, livePolicy, baseProvider);
				const accepted = await withScopeLock(scope, signal, () => {
					const recheckedPolicy = refreshRequestPolicy();
					if (getScope(coordinator, recheckedPolicy, baseProvider) !== scope
						|| !memberCurrent(recheckedPolicy, baseProvider, modelId, refreshed)) return false;
					// Do not reset a different member selected by another request.
					if (scope.activeProviderName === refreshed.name) {
						scope.activeIdentity = refreshed.state.identity;
						scope.version++;
					}
					return true;
				});
				if (!accepted) return undefined;
				current = refreshed;
				attemptedCredentials.add(refreshed.state.identity);
				onSelected(failing.model);
				try {
					policy!.requester?.refreshStatus?.();
				} catch {
					// Status delivery is advisory.
				}
			} else {
				return undefined;
			}
			return resolved;
		}
		if (bearer(resolved) && bearer(resolved) !== POOL_API_KEY) {
			const coordinator = getCoordinator(policy!.binding.raw);
			const sibling = { ...failing, resolved, ...credentialState(policy!.binding.raw, coordinator, failing.name, resolved) };
			const identity = sibling.state.identity;
			const livePolicy = refreshRequestPolicy();
			if (!attemptedCredentials.has(identity) && memberCurrent(livePolicy, baseProvider, modelId, sibling)
				&& !unavailable(policy!.binding.raw, sibling, modelId)) {
				const scope = getScope(coordinator, livePolicy, baseProvider);
				const accepted = await withScopeLock(scope, signal, () => {
					const recheckedPolicy = refreshRequestPolicy();
					if (getScope(coordinator, recheckedPolicy, baseProvider) !== scope
						|| !memberCurrent(recheckedPolicy, baseProvider, modelId, sibling)
						|| unavailable(policy!.binding.raw, sibling, modelId)) return false;
					scope.activeProviderName = sibling.name;
					scope.activeIdentity = sibling.state.identity;
					scope.version++;
					return true;
				});
				if (accepted) {
					current = sibling;
					attemptedCredentials.add(identity);
					onSelected(sibling.model);
					try {
						policy!.requester?.refreshStatus?.();
					} catch {
						// Status delivery is advisory.
					}
					return resolved;
				}
			}
		}
		return select(context, "limit");
	};
}
