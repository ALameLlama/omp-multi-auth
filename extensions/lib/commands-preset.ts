// ========================================================================
// /multi-auth-preset command handlers
// ========================================================================
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getAuthStorage, getModels, type MultiAuthConfig, type PresetEntry, type PresetConfig, type SubEntry, subProviderName } from "./core.ts";
import { loadGlobalConfig, saveGlobalConfig, findSelectableModelForProvider, parseEnvConfig, normalizeEntries, mergeConfigs, getProviderDisplayName } from "./config.ts";
import { subDisplayName, getBaseProvider, SUPPORTED_PROVIDERS, PROVIDER_TEMPLATES } from "./providers.ts";
import { showWrappedSelect } from "./ui.ts";
import type { SelectItem } from "@oh-my-pi/pi-tui";
import type { EnforceSelectedModel } from "../multi-auth.ts";

export function formatPresetEntry(entry: PresetEntry): string {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const displayName = getProviderDisplayName(entry.provider, allSubs);
	return `${displayName} / ${entry.model}`;
}

/** Lightweight version that takes pre-loaded subs to avoid re-reading config per entry. */
export function formatPresetEntryWith(entry: PresetEntry, allSubs: SubEntry[]): string {
	const displayName = getProviderDisplayName(entry.provider, allSubs);
	return `${displayName} / ${entry.model}`;
}

export async function handlePresetCreate(
	ctx: ExtensionCommandContext,
): Promise<void> {
	const presetName = await ctx.ui.input("Preset name", "e.g. coding-premium, coding-budget, fastest");
	if (!presetName?.trim()) return;

	const config = loadGlobalConfig();
	if (config.presets.find((p) => p.name === presetName.trim())) {
		const overwrite = await ctx.ui.confirm("Preset exists", `Overwrite "${presetName.trim()}"?`);
		if (!overwrite) return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allProviders: string[] = [];
	for (const provider of SUPPORTED_PROVIDERS) {
		allProviders.push(provider);
	}
	for (const entry of allSubs) {
		allProviders.push(subProviderName(entry));
	}

	const entries: PresetEntry[] = [];
	let adding = true;
	while (adding) {
		const providerOptions = [
			`--- Entries (${entries.length}): ${entries.map((e) => formatPresetEntryWith(e, allSubs)).join(", ") || "none"} ---`,
			...allProviders.map((p) => {
				const template = PROVIDER_TEMPLATES[p];
				const display = template?.displayName || p;
				const sub = allSubs.find((s) => subProviderName(s) === p);
				const label = sub ? subDisplayName(sub) : display;
				return `${p} -- ${label}`;
			}),
			"[Done - save preset]",
		];

		const picked = await ctx.ui.select("Add entry (Esc cancels)", providerOptions);
		if (!picked) return;
		if (picked.startsWith("---")) continue;
		if (picked === "[Done - save preset]") {
			if (entries.length === 0) {
				ctx.ui.notify("Add at least one entry.", "warning");
				continue;
			}
			adding = false;
			continue;
		}

		const provider = picked.split(" -- ")[0].trim();
		const base = getBaseProvider(provider);
		if (!base) continue;

		const models = (getModels(base as any) as Model<Api>[]).map((m) => m.id);
		if (models.length === 0) {
			ctx.ui.notify(`No models available for ${provider}.`, "warning");
			continue;
		}

		const model = await ctx.ui.select(`Model for ${provider}`, models);
		if (!model) continue;

		entries.push({ provider, model, enabled: true });
	}

	const preset: PresetConfig = {
		name: presetName.trim(),
		entries,
		enabled: true,
	};
	const existingIdx = config.presets.findIndex((p) => p.name === preset.name);
	if (existingIdx >= 0) {
		config.presets[existingIdx] = preset;
	} else {
		config.presets.push(preset);
	}
	saveGlobalConfig(config);
	ctx.ui.notify(
		`Preset "${preset.name}" saved with ${entries.length} ${entries.length === 1 ? "entry" : "entries"}: ${entries.map((e) => formatPresetEntryWith(e, allSubs)).join(", ")}`,
		"info",
	);
}

export async function handlePresetList(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured. Use /multi-auth-preset create to add one.", "info");
		return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const items: SelectItem[] = config.presets.map((preset) => ({
		value: preset.name,
		label: `${preset.enabled ? "+" : "-"} ${preset.name}`,
		description: preset.entries.map((e) => formatPresetEntryWith(e, allSubs)).join(" -> "),
	}));

	await showWrappedSelect(ctx, {
		title: "Model Presets",
		subtitle: "Presets are named routing shortcuts across providers.",
		items,
		confirmHint: "back",
		cancelHint: "close",
	});
}

export async function handlePresetActivate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedName: string | undefined,
	enforceSelectedModel: EnforceSelectedModel,
): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const enabled = config.presets.filter((p) => p.enabled);
	if (enabled.length === 0) {
		ctx.ui.notify("No enabled presets. Use /multi-auth-preset create to add one.", "info");
		return;
	}

	let presetName = requestedName?.trim();
	if (!presetName) {
		presetName = await showWrappedSelect(ctx, {
			title: "Activate Preset",
			subtitle: "Select a preset to switch to its best available entry.",
			items: enabled.map((p) => ({
				value: p.name,
				label: p.name,
				description: p.entries.filter((e) => e.enabled).map((e) => formatPresetEntryWith(e, allSubs)).join(" -> "),
			})),
			confirmHint: "activate",
			cancelHint: "back",
		});
	}
	if (!presetName) return;

	const preset = enabled.find((p) => p.name === presetName);
	if (!preset) {
		ctx.ui.notify(`Preset "${presetName}" not found.`, "error");
		return;
	}

	for (const entry of preset.entries) {
		if (!entry.enabled) continue;
		if (!getAuthStorage(ctx).hasAuth(entry.provider)) continue;
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model) continue;

		const success = await pi.setModel(model);
		if (!success) continue;

		if (!await enforceSelectedModel(ctx, model)) return;
		const selectedModel = ctx.models.current();
		if (!selectedModel) return;

		const prettyEntry = `${getProviderDisplayName(selectedModel.provider, allSubs)} / ${selectedModel.id}`;
		ctx.ui.notify(`Preset "${preset.name}": switched to ${prettyEntry}`, "info");
		ctx.ui.setStatus("multi-auth", `preset:${preset.name} | ${prettyEntry}`);
		return;
	}

	ctx.ui.notify(
		`Preset "${preset.name}": no entry has a logged-in provider with the required model available.`,
		"warning",
	);
}

export async function handlePresetRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets to remove.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Remove Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: p.name,
			description: `${p.entries.length} entries`,
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selected) return;

	const confirmed = await ctx.ui.confirm("Confirm", `Remove preset "${selected}"?`);
	if (!confirmed) return;

	config.presets = config.presets.filter((p) => p.name !== selected);
	saveGlobalConfig(config);
	ctx.ui.notify(`Removed preset "${selected}".`, "info");
}

export async function handlePresetToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Toggle Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: `${p.enabled ? "+" : "-"} ${p.name}`,
			description: p.enabled ? "enabled" : "disabled",
		})),
		confirmHint: "toggle",
		cancelHint: "back",
	});
	if (!selected) return;

	const preset = config.presets.find((p) => p.name === selected);
	if (!preset) return;

	preset.enabled = !preset.enabled;
	saveGlobalConfig(config);
	ctx.ui.notify(`Preset "${preset.name}" is now ${preset.enabled ? "enabled" : "disabled"}.`, "info");
}

export async function handlePresetMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	enforceSelectedModel: EnforceSelectedModel,
): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "activate", label: "activate", description: "Switch to a preset's best available entry" },
		{ value: "create", label: "create", description: "Create a new preset" },
		{ value: "list", label: "list", description: "Show all presets" },
		{ value: "toggle", label: "toggle", description: "Enable/disable a preset" },
		{ value: "remove", label: "remove", description: "Delete a preset" },
	];

	let preferredAction = "activate";
	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Model Presets",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		switch (action) {
			case "activate":
				await handlePresetActivate(pi, ctx, undefined, enforceSelectedModel);
				break;
			case "create":
				await handlePresetCreate(ctx);
				break;
			case "list":
				await handlePresetList(ctx);
				break;
			case "toggle":
				await handlePresetToggle(ctx);
				break;
			case "remove":
				await handlePresetRemove(ctx);
				break;
		}
	}
}
