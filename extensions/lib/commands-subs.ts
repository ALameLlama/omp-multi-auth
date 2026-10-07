// ========================================================================
// /multi-auth command handlers
// ========================================================================
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getAuthStorage, getModels, subProviderName, type MultiAuthConfig, type SubEntry } from "./core.ts";
import { loadGlobalConfig, loadProjectConfig, saveGlobalConfig, parseEnvConfig, mergeConfigs, normalizeEntries, getSubscriptionSource, formatSubscriptionMeta, formatSubscriptionListLine, formatSubscriptionStatus, getProviderDisplayName } from "./config.ts";
import { PROVIDER_TEMPLATES, SUPPORTED_PROVIDERS, getBaseProvider, subDisplayName, registerSub, registerProviderPools } from "./providers.ts";
import { handleSubsLimits, invalidateStatusQuota, refreshQuotaStatusLine } from "./quota.ts";
import { showWrappedSelect } from "./ui.ts";
import type { SelectItem } from "@oh-my-pi/pi-tui";
import { evictPoolMember, getPoolStatus, listPoolMemberNames, pinPoolMember, poolProviderName, POOL_RESERVE_PERCENT, type PoolHostBinding } from "./pool.ts";
import type { EnforceSelectedModel } from "../multi-auth.ts";

function refreshCommandStatus(ctx: ExtensionCommandContext): void {
	refreshQuotaStatusLine({ ...ctx, model: ctx.models.current() });
}

function physicalProviderOptions(entries: SubEntry[]): Array<{ providerName: string; label: string }> {
	return [
		...SUPPORTED_PROVIDERS.map(providerName => ({
			providerName,
			label: PROVIDER_TEMPLATES[providerName]?.displayName || providerName,
		})),
		...entries.map(entry => ({ providerName: subProviderName(entry), label: subDisplayName(entry) })),
	];
}

async function logoutPhysicalProvider(ctx: ExtensionCommandContext, providerName: string, label: string): Promise<void> {
	await getAuthStorage(ctx).logout(providerName);
	evictPoolMember(ctx.modelRegistry.authStorage, providerName);
	invalidateStatusQuota(providerName);
	refreshCommandStatus(ctx);
	ctx.ui.notify(`Logged out of ${label}`, "info");
}

export function normalizeSwitchAllowedProviderNames(cwd: string): string[] | undefined {
	const project = loadProjectConfig(cwd);
	if (!project?.allowedSubs || project.allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(project.allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

export async function getSwitchableProviderOptions(
	ctx: ExtensionContext | ExtensionCommandContext,
): Promise<Array<{ providerName: string; label: string; description: string }>> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
	const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
	const options: Array<{ providerName: string; label: string; description: string }> = [];
	const seen = new Set<string>();
	const push = (providerName: string, label: string, description: string) => {
		if (allowed && !allowed.has(providerName)) return;
		if (!getAuthStorage(ctx).hasAuth(providerName)) return;
		if (seen.has(providerName)) return;
		seen.add(providerName);
		options.push({ providerName, label, description });
	};

	for (const providerName of SUPPORTED_PROVIDERS) {
		push(
			providerName,
			PROVIDER_TEMPLATES[providerName]?.displayName || providerName,
			"base provider",
		);
	}
	for (const entry of allSubs) {
		push(subProviderName(entry), subDisplayName(entry), "extra subscription");
	}
	for (const baseProvider of SUPPORTED_PROVIDERS) {
		const providerName = poolProviderName(baseProvider);
		if (seen.has(providerName)) continue;
		const poolModel = await resolveSwitchTargetModel(ctx, providerName, ctx.models.current()?.id);
		if (!poolModel) continue;
		seen.add(providerName);
		options.push({
			providerName,
			label: getProviderDisplayName(providerName, allSubs),
			description: "shared subscription pool | 15% soft headroom",
		});
	}
	return options;
}

export async function resolveSwitchTargetModel(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Promise<Model<Api> | undefined> {
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) return undefined;
	const isPool = providerName === poolProviderName(baseProvider);
	if (!isPool && !getAuthStorage(ctx).hasAuth(providerName)) return undefined;
	const modelIds = [...new Set([
		...(preferredModelId ? [preferredModelId] : []),
		...getModels(baseProvider).map(model => model.id),
	])];
	for (const modelId of modelIds) {
		const candidate = ctx.modelRegistry.find(providerName, modelId);
		if (!candidate) continue;
		if (isPool && (await listPoolMemberNames(ctx, baseProvider, modelId)).length === 0) continue;
		return candidate as Model<Api>;
	}
	return undefined;
}

export async function handleSubsSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedProviderName: string | undefined,
	enforceSelectedModel: EnforceSelectedModel,
): Promise<void> {
	const options = await getSwitchableProviderOptions(ctx);
	if (options.length === 0) {
		const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
		const suffix = allowedProviderNames && allowedProviderNames.length > 0
			? ` for this project restriction (${allowedProviderNames.join(", ")})`
			: "";
		ctx.ui.notify(`No authenticated subscriptions are available to switch${suffix}.`, "info");
		return;
	}

	let providerName = requestedProviderName?.trim();
	if (!providerName) {
		providerName = await showWrappedSelect(ctx, {
			title: "Switch Subscription",
			subtitle: "Select the subscription/provider to use now.",
			items: options.map((option) => ({
				value: option.providerName,
				label: option.label,
				description: option.description,
			})),
			initialValue: ctx.models.current()?.provider,
			confirmHint: "switch",
			cancelHint: "back",
		});
		if (!providerName) return;
	}

	const selected = options.find((option) => option.providerName === providerName);
	if (!selected) {
		ctx.ui.notify(`Subscription not available for switching: ${providerName}`, "error");
		return;
	}

	// Switching to a physical account pins it (no automatic pool promotion);
	// switching to the pool clears any pin.
	pinPoolMember(ctx, selected.providerName.endsWith("-pool") ? undefined : selected.providerName);

	const currentModel = ctx.models.current();
	const nextModel = await resolveSwitchTargetModel(ctx, selected.providerName, currentModel?.id);
	if (!nextModel) {
		ctx.ui.notify(`No selectable models found for ${selected.label}.`, "error");
		return;
	}
	if (currentModel?.provider === nextModel.provider && currentModel?.id === nextModel.id) {
		if (!await enforceSelectedModel(ctx, nextModel)) return;
		refreshCommandStatus(ctx);
		const actual = ctx.models.current();
		if (actual) ctx.ui.notify(`Already using ${getProviderDisplayName(actual.provider, normalizeEntries(mergeConfigs(loadGlobalConfig(), parseEnvConfig())))} (${actual.id}).`, "info");
		return;
	}

	const thinking = pi.getThinkingLevel();
	const success = await pi.setModel(nextModel);
	if (!success) {
		ctx.ui.notify(`Failed to switch to ${selected.label}.`, "error");
		return;
	}
	pi.setThinkingLevel(thinking);
	if (!await enforceSelectedModel(ctx, nextModel)) return;
	refreshCommandStatus(ctx);
	const actual = ctx.models.current();
	if (actual) {
		const displayName = getProviderDisplayName(actual.provider, normalizeEntries(mergeConfigs(loadGlobalConfig(), parseEnvConfig())));
		ctx.ui.notify(`Switched to ${displayName} (${actual.id}).`, "info");
	}
}

export async function renameSubscriptionLabel(
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
	entry: SubEntry,
): Promise<void> {
	const previousName = subDisplayName(entry);
	const nextLabel = await ctx.ui.input(
		"Friendly label (optional)",
		entry.label || "e.g. work, personal, team, outlook",
	);
	if (nextLabel === undefined) return;

	entry.label = nextLabel.trim() || undefined;
	saveGlobalConfig(config);

	const nextName = subDisplayName(entry);
	if (nextName === previousName) {
		ctx.ui.notify(`No changes for ${nextName}.`, "info");
		return;
	}

	ctx.ui.notify(`Updated ${previousName} -> ${nextName}`, "info");
}

export async function removeSubscriptionEntry(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
	entry: SubEntry,
	host: PoolHostBinding,
): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${subDisplayName(entry)}?\nThis will also logout if authenticated.`,
	);
	if (!confirmed) return;

	const name = subProviderName(entry);
	const selectedModel = ctx.models.current();
	if (getAuthStorage(ctx).hasAuth(name)) {
		await getAuthStorage(ctx).logout(name);
	}
	evictPoolMember(ctx.modelRegistry.authStorage, name);
	invalidateStatusQuota(name);
	pi.unregisterProvider(name);

	config.subscriptions = config.subscriptions.filter(
		(candidate) => !(candidate.provider === entry.provider && candidate.index === entry.index),
	);

	saveGlobalConfig(config);
	const mergedEntries = normalizeEntries(mergeConfigs(loadGlobalConfig(), parseEnvConfig()));
	registerProviderPools(pi, mergedEntries, host);
	ctx.modelRegistry.refresh();
	if (selectedModel?.provider === poolProviderName(entry.provider)) {
		if (!mergedEntries.some(candidate => candidate.provider === entry.provider)) {
			const allowed = normalizeSwitchAllowedProviderNames(ctx.cwd);
			const canonical = ctx.modelRegistry.find(entry.provider, selectedModel.id);
			if (canonical && getAuthStorage(ctx).hasAuth(entry.provider) && (!allowed || allowed.includes(entry.provider))) {
				const thinking = pi.getThinkingLevel();
				const switched = await pi.setModel(canonical);
				if (switched) pi.setThinkingLevel(thinking);
				else ctx.ui.notify(`multi-auth: no authenticated allowed pool members for ${entry.provider}/${selectedModel.id}.`, "warning");
			} else {
				ctx.ui.notify(`multi-auth: no authenticated allowed pool members for ${entry.provider}/${selectedModel.id}.`, "warning");
			}
		} else if ((await listPoolMemberNames(ctx, entry.provider, selectedModel.id)).length === 0) {
			ctx.ui.notify(`multi-auth: no authenticated allowed pool members for ${entry.provider}/${selectedModel.id}.`, "warning");
		}
	}
	refreshCommandStatus(ctx);
	ctx.ui.notify(`Removed ${subDisplayName(entry)}`, "info");
}
export function loginSubscription(ctx: ExtensionCommandContext, entry: SubEntry): void {
	const providerName = subProviderName(entry);
	ctx.ui.setEditorText(`/login ${providerName}`);
	ctx.ui.notify(`Press Enter to authenticate ${subDisplayName(entry)} with /login ${providerName}.`, "info");
}
export async function showSubscriptionActions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
	entry: SubEntry,
	host: PoolHostBinding,
	enforceSelectedModel: EnforceSelectedModel,
): Promise<void> {
	const source = getSubscriptionSource(config, entry);
	if (source === "env") {
		await showWrappedSelect(ctx, {
			title: `Subscription: ${subDisplayName(entry)}`,
			subtitle: "This entry comes from MULTI_SUB and is read-only here.",
			items: [
				{
					value: subProviderName(entry),
					label: formatSubscriptionListLine(entry, config, getAuthStorage(ctx)),
				},
			],
			confirmHint: "back",
			cancelHint: "back",
		});
		return;
	}

	const name = subProviderName(entry);
	const hasAuth = getAuthStorage(ctx).hasAuth(name);
	const actionItems: SelectItem[] = [
		{ value: "rename", label: "rename", description: "Change friendly label" },
		{ value: "switch", label: "switch", description: "Use this account's subscription pool when available" },
		hasAuth
			? { value: "logout", label: "logout", description: "Log out this subscription" }
			: { value: "login", label: "login", description: "Show login instructions" },
		{ value: "remove", label: "remove", description: "Remove this subscription" },
	];

	const action = await showWrappedSelect(ctx, {
		title: subDisplayName(entry),
		subtitle: "Escape returns to the subscriptions list.",
		items: actionItems,
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return;

	if (action === "rename") {
		return renameSubscriptionLabel(ctx, config, entry);
	}
	if (action === "login") {
		return loginSubscription(ctx, entry);
	}
	if (action === "logout") {
		return logoutPhysicalProvider(ctx, name, subDisplayName(entry));
	}
	if (action === "switch") {
		return handleSubsSwitch(pi, ctx, name, enforceSelectedModel);
	}
	if (action === "remove") {
		return removeSubscriptionEntry(pi, ctx, config, entry, host);
	}
}

export async function handleSubsList(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
	host: PoolHostBinding,
	enforceSelectedModel: EnforceSelectedModel,
): Promise<void> {
	let preferredProviderName: string | undefined = ctx.models.current()?.provider;

	while (true) {
		const envEntries = parseEnvConfig();
		const all = normalizeEntries(mergeConfigs(config, envEntries));


		const selectedProviderName = await showWrappedSelect(ctx, {
			title: "Subscriptions",
			subtitle: "Select a subscription for quick actions.",
			items: [
				...SUPPORTED_PROVIDERS.map(providerName => ({
					value: providerName,
					label: PROVIDER_TEMPLATES[providerName]?.displayName || providerName,
					description: `base provider | ${getAuthStorage(ctx).hasAuth(providerName) ? "logged in" : "not logged in"}`,
				})),
				...all.map(entry => ({
					value: subProviderName(entry),
					label: subDisplayName(entry),
					description: formatSubscriptionMeta(entry, config, getAuthStorage(ctx)),
				})),
			],
			initialValue: preferredProviderName,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!selectedProviderName) return;

		preferredProviderName = selectedProviderName;
		if (SUPPORTED_PROVIDERS.includes(selectedProviderName)) {
			const label = PROVIDER_TEMPLATES[selectedProviderName]?.displayName || selectedProviderName;
			const authenticated = getAuthStorage(ctx).hasAuth(selectedProviderName);
			const action = await showWrappedSelect(ctx, {
				title: label,
				items: [
					{ value: "switch", label: "switch", description: "Use this provider's subscription pool when available" },
					authenticated
						? { value: "logout", label: "logout", description: "Log out the base account" }
						: { value: "login", label: "login", description: "Show login instructions" },
				],
				confirmHint: "open",
				cancelHint: "back",
			});
			if (action === "switch") await handleSubsSwitch(pi, ctx, selectedProviderName, enforceSelectedModel);
			if (action === "logout") await logoutPhysicalProvider(ctx, selectedProviderName, label);
			if (action === "login") {
				ctx.ui.setEditorText(`/login ${selectedProviderName}`);
				ctx.ui.notify(`Press Enter to authenticate ${label} with /login ${selectedProviderName}.`, "info");
			}
			continue;
		}
		const entry = all.find((candidate) => subProviderName(candidate) === selectedProviderName);
		if (!entry) continue;
		await showSubscriptionActions(pi, ctx, config, entry, host, enforceSelectedModel);
	}
}

export async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, host: PoolHostBinding): Promise<void> {
	const providerItems: SelectItem[] = SUPPORTED_PROVIDERS.map((provider) => ({
		value: provider,
		label: provider,
		description: PROVIDER_TEMPLATES[provider]?.displayName,
	}));

	const provider = await showWrappedSelect(ctx, {
		title: "Select provider to add",
		items: providerItems,
		confirmHint: "select",
		cancelHint: "close",
	});
	if (!provider) return;

	if (!PROVIDER_TEMPLATES[provider]) {
		ctx.ui.notify(`Unknown provider: ${provider}`, "error");
		return;
	}

	const label = await ctx.ui.input("Label (optional)", "e.g. work, personal");

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allEntries = normalizeEntries(mergeConfigs(config, envEntries));
	const usedIndices = new Set(
		allEntries.filter((e) => e.provider === provider).map((e) => e.index),
	);
	let nextIndex = 2;
	while (usedIndices.has(nextIndex)) nextIndex++;

	const entry: SubEntry = {
		provider,
		index: nextIndex,
		label: label?.trim() || undefined,
	};

	config.subscriptions.push(entry);
	saveGlobalConfig(config);

	registerSub(pi, entry);
	registerProviderPools(pi, normalizeEntries(mergeConfigs(loadGlobalConfig(), parseEnvConfig())), host);
	ctx.modelRegistry.refresh();
	refreshCommandStatus(ctx);

	const loginNow = await ctx.ui.confirm(
		subDisplayName(entry),
		`Created ${subDisplayName(entry)}.\n\nLogin now?`,
	);

	if (loginNow) {
		await loginSubscription(ctx, entry);
	} else {
		ctx.ui.notify(`Added ${subDisplayName(entry)}. Use /multi-auth login to authenticate.`, "info");
	}
}

export async function handleSubsRemove(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	host: PoolHostBinding,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.subscriptions.length === 0) {
		ctx.ui.notify("No saved subscriptions to remove.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Remove subscription",
		subtitle: "Select a saved subscription to remove.",
		initialValue: ctx.models.current()?.provider,
		items: config.subscriptions.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: formatSubscriptionStatus(entry, getAuthStorage(ctx)),
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = config.subscriptions.find(
		(candidate) => subProviderName(candidate) === selectedProviderName,
	);
	if (!entry) return;

	return removeSubscriptionEntry(pi, ctx, config, entry, host);
}

export async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = physicalProviderOptions(normalizeEntries(mergeConfigs(config, envEntries)));
	const notLoggedIn = all.filter(option => !getAuthStorage(ctx).hasAuth(option.providerName));

	if (notLoggedIn.length === 0) {
		ctx.ui.notify("All subscriptions are already logged in.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Login to subscription",
		subtitle: "Select a subscription to authenticate.",
		initialValue: ctx.models.current()?.provider,
		items: notLoggedIn.map(option => ({
			value: option.providerName,
			label: option.label,
			description: "not logged in",
		})),
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const selected = notLoggedIn.find(option => option.providerName === selectedProviderName);
	if (!selected) return;
	ctx.ui.setEditorText(`/login ${selected.providerName}`);
	ctx.ui.notify(`Press Enter to authenticate ${selected.label} with /login ${selected.providerName}.`, "info");
}

export async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = physicalProviderOptions(normalizeEntries(mergeConfigs(config, envEntries)));
	const loggedIn = all.filter(option => getAuthStorage(ctx).hasAuth(option.providerName));

	if (loggedIn.length === 0) {
		ctx.ui.notify("No subscriptions are currently logged in.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Logout from subscription",
		subtitle: "Select a subscription to log out.",
		initialValue: ctx.models.current()?.provider,
		items: loggedIn.map(option => ({
			value: option.providerName,
			label: option.label,
			description: "logged in",
		})),
		confirmHint: "logout",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const selected = loggedIn.find(option => option.providerName === selectedProviderName);
	if (!selected) return;
	await logoutPhysicalProvider(ctx, selected.providerName, selected.label);
}

export async function handleSubsStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const currentModel = ctx.models.current();

	const lines: string[] = [];
	for (const physical of physicalProviderOptions(all)) {
		const name = physical.providerName;
		const cred = getAuthStorage(ctx).get(name);
		const hasAuth = getAuthStorage(ctx).hasAuth(name);

		let status: string;
		if (!hasAuth) {
			status = "not logged in";
		} else if (cred?.type === "oauth") {
			const expiresIn = typeof cred.expires === "number" ? cred.expires - Date.now() : 0;
			if (expiresIn > 0) {
				const mins = Math.round(expiresIn / 60000);
				status = `logged in (expires ${mins}m)`;
			} else {
				status = "logged in (token expired, will refresh)";
			}
		} else {
			status = "logged in (api key)";
		}

		const entry = all.find(candidate => subProviderName(candidate) === name);
		const baseProvider = getBaseProvider(name);
		const modelCount = baseProvider ? getModels(baseProvider).length : 0;
		const source = entry ? getSubscriptionSource(config, entry) : "built-in";
		lines.push(`${name} (${physical.label}) | ${status} | ${modelCount} models | ${source}`);
	}
	for (const baseProvider of SUPPORTED_PROVIDERS) {
		const providerName = poolProviderName(baseProvider);
		const poolModels = ctx.modelRegistry.getAll("all").filter(model => model.provider === providerName);
		if (poolModels.length === 0) continue;
		const relevantModels = currentModel && getBaseProvider(currentModel.provider) === baseProvider
			? poolModels.filter(model => model.id === currentModel.id)
			: poolModels;
		const memberNames = new Set<string>();
		let activeProviderName: string | undefined;
		for (const model of relevantModels) {
			for (const name of await listPoolMemberNames(ctx, baseProvider, model.id)) memberNames.add(name);
			activeProviderName ??= getPoolStatus({ ...ctx, model })?.activeProviderName;
		}
		const members = [...memberNames].map(name => `${name} (${getProviderDisplayName(name, all)})`).join(", ") || "none";
		lines.push(`${providerName} | ${memberNames.size} permitted/authenticated accounts | ${members} | active: ${activeProviderName ?? "pending"} | ${POOL_RESERVE_PERCENT}% soft headroom`);
		if (baseProvider === "openai-codex") {
			lines.push(`  ↳ note: native Code Mode and /fast controls are unsupported`);
		}
	}

	await showWrappedSelect(ctx, {
		title: "Subscription Status",
		subtitle: "Press Enter or Escape to go back.",
		items: lines.map((line, index) => ({ value: `${index}:${line}`, label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}
export async function handleSubsMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	host: PoolHostBinding,
	enforceSelectedModel: EnforceSelectedModel,
): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "list", label: "list", description: "Show built-in and extra subscriptions" },
		{ value: "add", label: "add", description: "Add a new subscription" },
		{ value: "remove", label: "remove", description: "Remove a subscription" },
		{ value: "login", label: "login", description: "Login to a subscription" },
		{ value: "logout", label: "logout", description: "Logout from a subscription" },
		{ value: "switch", label: "switch", description: "Switch to a different subscription/provider now" },
		{ value: "status", label: "status", description: "Show auth status and token info" },
		{ value: "limits", label: "limits", description: "Check built-in quota support (Codex + Google)" },
	];
	let preferredAction = "list";

	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Subscription Manager",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		const config = loadGlobalConfig();
		switch (action) {
			case "list":
				await handleSubsList(pi, ctx, config, host, enforceSelectedModel);
				break;
			case "add":
				await handleSubsAdd(pi, ctx, host);
				break;
			case "remove":
				await handleSubsRemove(pi, ctx, host);
				break;
			case "login":
				await handleSubsLogin(ctx);
				break;
			case "logout":
				await handleSubsLogout(ctx);
				break;
			case "switch":
				await handleSubsSwitch(pi, ctx, undefined, enforceSelectedModel);
				break;
			case "status":
				await handleSubsStatus(ctx);
				break;
			case "limits":
				await handleSubsLimits(ctx);
				break;
		}
	}
}
