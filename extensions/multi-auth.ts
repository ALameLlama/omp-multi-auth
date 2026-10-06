import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { loadGlobalConfig, parseEnvConfig, mergeConfigs, normalizeEntries, loadEffectiveConfig, formatAllowedProviderSummary, getProjectScopedProviderNames, findSelectableModelForProvider, getProviderDisplayName } from "./lib/config.ts";
import { getBaseProvider, getPoolModelForSelection, registerProviderPools, registerSub, rewriteAntigravitySystemInstruction } from "./lib/providers.ts";
import { handleSubsMenu, handleSubsList, handleSubsAdd, handleSubsRemove, handleSubsLogin, handleSubsLogout, handleSubsSwitch, handleSubsStatus } from "./lib/commands-subs.ts";
import { handleSubsLimits, refreshQuotaStatusLine, invalidateStatusQuota } from "./lib/quota.ts";
import { handlePresetActivate, handlePresetCreate, handlePresetList, handlePresetToggle, handlePresetRemove, handlePresetMenu } from "./lib/commands-preset.ts";
import { getAuthStorage, subProviderName } from "./lib/core.ts";
import { bindPoolSession, createPoolHostBinding, listPoolMemberNames, poolProviderName, preferPoolMember, setPoolStatusCallback, unbindPoolSession } from "./lib/pool.ts";

export type EnforceSelectedModel = (
	ctx: ExtensionContext | ExtensionCommandContext,
	selectedModel: Model<Api>,
) => Promise<boolean>;

// ========================================================================
// Extension entry point
// ========================================================================

export default function multiSub(pi: ExtensionAPI) {
	const poolHost = createPoolHostBinding();

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	// Register all subscriptions (always global)
	for (const entry of all) {
		registerSub(pi, entry);
	}
	registerProviderPools(pi, all, poolHost);

	// Break Cloud Code Assist's system-prompt fingerprint at the OMP payload seam (base provider).
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider === "google-antigravity") {
			return rewriteAntigravitySystemInstruction(event.payload);
		}
	});

	let modelEnforcementInFlight = false;
	const reconstructedPoolModels = new WeakSet<Model<Api>>();
	const warnedCodexSessions = new Set<string>();
	const bindSession = (ctx: ExtensionContext) => {
		const wasBound = Boolean(poolHost.registry);
		bindPoolSession(ctx, poolHost);
		if (!wasBound) {
			// Native custom APIs are process-wide. Install this factory's stream
			// only after its host is bound, before any session can dispatch.
			const globalConfig = loadGlobalConfig();
			const entries = normalizeEntries(mergeConfigs(globalConfig, parseEnvConfig()));
			registerProviderPools(pi, entries, poolHost);
		}
		setPoolStatusCallback(ctx, () => refreshQuotaStatusLine(ctx));
	};
	const setModelPreservingThinking = async (model: Model<Api>): Promise<boolean> => {
		const thinkingLevel = pi.getThinkingLevel();
		const success = await pi.setModel(model);
		if (success && thinkingLevel !== undefined) pi.setThinkingLevel(thinkingLevel);
		return success;
	};
	const warnCodexPool = (ctx: ExtensionContext | ExtensionCommandContext, baseProvider: string) => {
		if (baseProvider !== "openai-codex") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (warnedCodexSessions.has(sessionId)) return;
		warnedCodexSessions.add(sessionId);
		ctx.ui.notify("multi-auth: Codex subscription pool active; native Code Mode and /fast controls are unavailable.", "warning");
	};
	const noPoolMembers = (ctx: ExtensionContext | ExtensionCommandContext, baseProvider: string, modelId: string): false => {
		ctx.ui.notify(`multi-auth: no authenticated allowed pool members for ${baseProvider}/${modelId}.`, "warning");
		return false;
	};
	const enforceModel = async (ctx: ExtensionContext | ExtensionCommandContext): Promise<boolean> => {
		// Lifecycle, input and command-driven selection share this guard so
		// restriction and promotion cannot switch back to a physical account.
		if (modelEnforcementInFlight) return true;
		modelEnforcementInFlight = true;
		try {
			const effective = loadEffectiveConfig(ctx.sessionManager.getCwd());
			const allowedSummary = formatAllowedProviderSummary(effective);
			ctx.ui.setStatus("multi-auth", allowedSummary ? `allowed ${allowedSummary}` : undefined);
			let selectedModel = ctx.model;
			let baseProvider = selectedModel && getBaseProvider(selectedModel.provider);
			let isPool = Boolean(baseProvider && selectedModel?.provider === poolProviderName(baseProvider));

			// A pool is a route, never an account in the project's exact allow-list.
			// Preserve the existing physical restriction switch/fallback first.
			if (!isPool && allowedSummary && (!selectedModel || !effective.allowedProviderNames?.includes(selectedModel.provider))) {
				let switched = false;
				for (const providerName of getProjectScopedProviderNames(ctx, effective)) {
					const model = findSelectableModelForProvider(ctx, providerName, selectedModel?.id);
					if (!model || !await setModelPreservingThinking(model)) continue;
					selectedModel = ctx.model ?? model;
					const displayName = getProviderDisplayName(providerName, effective.subscriptions);
					ctx.ui.notify(
						`multi-auth: project restricted to ${allowedSummary}; switched to ${displayName} (${model.id}).`,
						"info",
					);
					switched = true;
					break;
				}
				if (!switched) {
					const currentModel = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "the current model";
					ctx.ui.notify(
						`multi-auth: project restricted to ${allowedSummary}, but no authenticated allowed provider can serve ${currentModel}.`,
						"warning",
					);
					return false;
				}
				baseProvider = selectedModel && getBaseProvider(selectedModel.provider);
				isPool = Boolean(baseProvider && selectedModel?.provider === poolProviderName(baseProvider));
			}

			if (!selectedModel || !baseProvider) return true;
			if (isPool) {
				const members = await listPoolMemberNames(ctx, baseProvider, selectedModel.id);
				if (!ctx.modelRegistry.find(poolProviderName(baseProvider), selectedModel.id)) {
					// A removed route has no marker key. Authentication recovery
					// must restore the permitted canonical model, not admit it here.
					const canonicalModel = members.includes(baseProvider)
						? ctx.modelRegistry.find(baseProvider, selectedModel.id)
						: undefined;
					return canonicalModel && await setModelPreservingThinking(canonicalModel)
						? true
						: noPoolMembers(ctx, baseProvider, selectedModel.id);
				}
				// Direct pool selections also need metadata omitted by registration
				// overlays. Reconstruct once, not on every subsequent input.
				if (!reconstructedPoolModels.has(selectedModel)) {
					const completeModel = getPoolModelForSelection(selectedModel);
					if (completeModel && await setModelPreservingThinking(completeModel)) {
						reconstructedPoolModels.add(completeModel);
						if (ctx.model) reconstructedPoolModels.add(ctx.model);
					}
				}
				warnCodexPool(ctx, baseProvider);
				return members.length > 0 || noPoolMembers(ctx, baseProvider, selectedModel.id);
			}

			// Activation counts globally authenticated physical names, even if
			// only one of them serves this particular model or project.
			const globalConfig = loadGlobalConfig();
			const globalEntries = normalizeEntries(mergeConfigs(globalConfig, parseEnvConfig()));
			const physicalNames = new Set([
				baseProvider,
				...globalEntries.filter(entry => entry.provider === baseProvider).map(subProviderName),
			]);
			const authStorage = getAuthStorage(ctx);
			const authenticatedCount = [...physicalNames].filter(name => authStorage.hasAuth(name)).length;
			if (authenticatedCount < 2) return true;
			if (!ctx.modelRegistry.find(poolProviderName(baseProvider), selectedModel.id)) return true;
			const poolModel = getPoolModelForSelection(selectedModel);
			if (!poolModel) return true;
			const members = await listPoolMemberNames(ctx, baseProvider, selectedModel.id);
			if (members.length === 0) return noPoolMembers(ctx, baseProvider, selectedModel.id);

			preferPoolMember(ctx, selectedModel.provider);
			if (await setModelPreservingThinking(poolModel)) {
				reconstructedPoolModels.add(poolModel);
				if (ctx.model) reconstructedPoolModels.add(ctx.model);
				warnCodexPool(ctx, baseProvider);
			}
			return true;
		} finally {
			modelEnforcementInFlight = false;
		}
	};
	const enforceSelectedModel: EnforceSelectedModel = async (ctx, selectedModel) => {
		// Command contexts snapshot model; the query facade retains the native
		// live getter, including the pool model installed during this callback.
		const freshContext = {
			...ctx,
			// Native event-context services may be non-enumerable getters.
			sessionManager: ctx.sessionManager,
			modelRegistry: ctx.modelRegistry,
			models: ctx.models,
			ui: ctx.ui,
			get model() {
				return ctx.models.current() ?? selectedModel;
			},
		};
		bindSession(freshContext);
		const ok = await enforceModel(freshContext);
		refreshQuotaStatusLine(freshContext);
		return ok;
	};

	// Each main/child factory binds its own immutable registry before routing.
	pi.on("session_start", async (_event, ctx) => {
		bindSession(ctx);
		await enforceModel(ctx);
		refreshQuotaStatusLine(ctx);
		if ("setInterval" in ctx && typeof ctx.setInterval === "function") {
			ctx.setInterval(() => refreshQuotaStatusLine(ctx), 60_000);
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		bindSession(ctx);
		await enforceModel(ctx);
		refreshQuotaStatusLine(ctx);
	});

	pi.on("session_branch", async (_event, ctx) => {
		bindSession(ctx);
		await enforceModel(ctx);
		refreshQuotaStatusLine(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		unbindPoolSession(sessionId);
		warnedCodexSessions.delete(sessionId);
	});

	pi.on("input", async (event, ctx) => {
		if (event.text.trimStart().startsWith("/")) {
			return;
		}
		bindSession(ctx);
		const ok = await enforceModel(ctx);
		refreshQuotaStatusLine(ctx);
		return { handled: !ok };
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.model) {
			invalidateStatusQuota(ctx.model.provider);
		}
		refreshQuotaStatusLine(ctx);
	});
	// Register /multi-auth command
	pi.registerCommand("multi-auth", {
		description: "Manage multi-account OAuth subscriptions and accounts",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "add", "remove", "login", "logout", "switch", "status", "limits"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = loadGlobalConfig();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "list":
				case "ls":
					return handleSubsList(pi, ctx, config, poolHost, enforceSelectedModel);
				case "add":
				case "new":
					return handleSubsAdd(pi, ctx, poolHost);
				case "remove":
				case "rm":
				case "delete":
					return handleSubsRemove(pi, ctx, poolHost);
				case "login":
					return handleSubsLogin(ctx);
				case "logout":
					return handleSubsLogout(ctx);
				case "switch":
					return handleSubsSwitch(pi, ctx, rest || undefined, enforceSelectedModel);
				case "status":
				case "info":
					return handleSubsStatus(ctx);
				case "limits":
				case "quota":
				case "usage":
					return handleSubsLimits(ctx);
				default:
					return handleSubsMenu(pi, ctx, poolHost, enforceSelectedModel);
			}
		},
	});

	// Register /multi-auth-preset command
	pi.registerCommand("multi-auth-preset", {
		description: "Manage model presets across providers",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["activate", "create", "list", "toggle", "remove"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			if (filtered.length > 0) {
				return filtered.map((s) => ({ value: s, label: s }));
			}
			const config = loadGlobalConfig();
			const presetNames = config.presets
				.filter((p) => p.enabled && p.name.startsWith(prefix))
				.map((p) => ({ value: p.name, label: p.name }));
			return presetNames.length > 0 ? presetNames : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "activate":
				case "use":
					return handlePresetActivate(pi, ctx, rest || undefined, enforceSelectedModel);
				case "create":
				case "new":
					return handlePresetCreate(ctx);
				case "list":
				case "ls":
					return handlePresetList(ctx);
				case "toggle":
					return handlePresetToggle(ctx);
				case "remove":
				case "rm":
				case "delete":
					return handlePresetRemove(ctx);
				default:
					if (subcommand) {
						const config = loadGlobalConfig();
						const preset = config.presets.find(
							(p) => p.name.toLowerCase() === subcommand && p.enabled,
						);
						if (preset) {
							return handlePresetActivate(pi, ctx, preset.name, enforceSelectedModel);
						}
					}
					return handlePresetMenu(pi, ctx, enforceSelectedModel);
			}
		},
	});
}
