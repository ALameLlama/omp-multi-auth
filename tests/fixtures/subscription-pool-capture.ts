import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { getOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { handleSubsAdd, handleSubsStatus, removeSubscriptionEntry } from "../../extensions/lib/commands-subs.ts";
import { loadEffectiveConfig, loadGlobalConfig, mergeConfigs, normalizeEntries, parseEnvConfig } from "../../extensions/lib/config.ts";
import * as pool from "../../extensions/lib/pool.ts";
import type { PoolHostBinding } from "../../extensions/lib/pool.ts";
import * as providers from "../../extensions/lib/providers.ts";

type Quota = number | [number, number] | "missing" | "failed";
interface FixtureState {
  quotas: Record<string, Quota>;
  failures?: Record<string, "limit" | "transient">;
  responsePrefix?: string;
  children?: boolean;
  hold?: boolean;
  holdRole?: string;
  pauseNumbered?: boolean;
  proceedNumbered?: boolean;
  release?: boolean;
  quotaDelayMs?: number;
}
interface RequestHook {
  type: string;
  kind: string;
  agentId: string;
  sessionId: string;
  provider?: string;
  payload: unknown;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function state(): FixtureState {
  const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (!isObject(raw) || !isObject(raw.quotas)) throw new Error("invalid fixture state");
  const quotas: Record<string, Quota> = {};
  for (const [name, quota] of Object.entries(raw.quotas)) {
    if (typeof quota === "number" || quota === "missing" || quota === "failed") quotas[name] = quota;
    else if (Array.isArray(quota) && quota.length === 2 && quota.every((value: unknown) => typeof value === "number")) quotas[name] = [Number(quota[0]), Number(quota[1])];
    else throw new Error(`invalid quota fixture: ${name}`);
  }
  const failures: Record<string, "limit" | "transient"> = {};
  if (isObject(raw.failures)) for (const [name, failure] of Object.entries(raw.failures)) {
    if (failure !== "limit" && failure !== "transient") throw new Error("invalid failure fixture");
    failures[name] = failure;
  }
  return {
    quotas, failures,
    responsePrefix: typeof raw.responsePrefix === "string" ? raw.responsePrefix : undefined,
    children: raw.children === true, hold: raw.hold === true,
    holdRole: typeof raw.holdRole === "string" ? raw.holdRole : undefined,
    pauseNumbered: raw.pauseNumbered === true, proceedNumbered: raw.proceedNumbered === true,
    release: raw.release === true, quotaDelayMs: typeof raw.quotaDelayMs === "number" ? raw.quotaDelayMs : undefined,
  };
}
async function fixtureDelay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

// This fixture never delegates to the original fetch. Unknown URLs are failures.
const statePath = process.env.POOL_FIXTURE_STATE!;
const tracePath = process.env.POOL_FIXTURE_TRACE!;
const trace = (record: Record<string, unknown>) => appendFileSync(tracePath, JSON.stringify({ time: Date.now(), ...record }) + "\n");
const pending: RequestHook[] = [];
const attempts = new Map<string, number>();
let sequence = 0;
const encode = new TextEncoder();
const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function responseFrames(text: string, tool = false, child = false) {
  const id = `response_fixture_${++sequence}`;
  const itemId = `item_fixture_${sequence}`;
  const args = JSON.stringify({ context: "Exercise both pooled child routes.", tasks: [
    { name: "DefaultPoolChild", task: "Return CHILD_DEFAULT.", solutionSpace: "one fixed response" },
    { name: "NumberedPoolChild", task: "Return CHILD_NUMBERED.", solutionSpace: "one fixed response", model: "openai-codex-2/gpt-5.5" },
  ] });
  const items = [tool
    ? { id: itemId, type: "function_call", call_id: `call_fixture_${sequence}`, name: "task", arguments: args, status: "completed" }
    : { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
  if (child) items.push({ id: `${itemId}_yield`, type: "function_call", call_id: `call_fixture_${sequence}_yield`, name: "yield", arguments: JSON.stringify({ data: text }), status: "completed" });
  let frames = frame("response.created", { response: { id, status: "in_progress", output: [] } });
  let terminal = "";
  for (const [index, item] of items.entries()) {
    frames += frame("response.output_item.added", { output_index: index, item: item.type === "function_call" ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
    if (item.type === "function_call") {
      frames += frame("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: item.arguments });
      frames += frame("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: item.arguments });
    } else {
      frames += frame("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      frames += frame("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta: text });
      frames += frame("response.output_text.done", { item_id: item.id, output_index: index, content_index: 0, text });
    }
    terminal += frame("response.output_item.done", { output_index: index, item });
  }
  terminal += frame("response.completed", { response: { id, status: "completed", output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return { frames, terminal };
}

function kimiResponse(text: string) {
  const events = [
    ["message_start", { type: "message_start", message: { id: `kimi_${++sequence}`, type: "message", role: "assistant", model: "kimi-for-coding", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function account(headers: Headers) {
  const identity = headers.get("chatgpt-account-id");
  if (identity === "pool-account-a") return "A";
  if (identity === "pool-account-b") return "B";
  const token = headers.get("x-api-key") ?? headers.get("authorization") ?? "";
  if (token.includes("pool-kimi-a") || token.includes("pool-external-a")) return "A";
  if (token.includes("pool-kimi-b")) return "B";
  throw new Error(`fixture: unrecognized account identity at ${identity ?? "missing account header"}`);
}

globalThis.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input));
  const headers = new Headers(init.headers ?? request?.headers);
  const raw = init.body ?? (request ? new Uint8Array(await request.clone().arrayBuffer()) : undefined);
  let bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw)
    : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer())
    : undefined;
  const contentEncoding = headers.get("content-encoding")?.toLowerCase();
  if (bytes && contentEncoding && contentEncoding !== "identity") {
    if (contentEncoding === "zstd") bytes = Bun.zstdDecompressSync(bytes);
    else if (contentEncoding === "gzip") bytes = gunzipSync(bytes);
    else if (contentEncoding === "br") bytes = brotliDecompressSync(bytes);
    else if (contentEncoding === "deflate") bytes = inflateSync(bytes);
    else throw new Error(`fixture: unsupported native request encoding ${contentEncoding}`);
  }
  const textBody = typeof raw === "string" ? raw : bytes ? new TextDecoder().decode(bytes) : undefined;
  const parsed: unknown = textBody ? JSON.parse(textBody) : raw;
  if (parsed !== undefined && !isObject(parsed)) throw new Error("invalid request JSON");
  const body = isObject(parsed) ? parsed : undefined;
  const current = state();
  if (url.pathname.endsWith("/wham/usage")) {
    const selected = account(headers);
    trace({ type: "quota", account: selected });
    if (current.quotaDelayMs) await fixtureDelay(current.quotaDelayMs);
    const quota = current.quotas[selected];
    if (quota === "failed") return new Response("quota unavailable", { status: 503 });
    if (quota === "missing") return Response.json({ plan_type: "pro" });
    const [short, weekly] = Array.isArray(quota) ? quota : [quota, quota];
    const reset = Math.floor(Date.now() / 1000) + 7200;
    return Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 100 - short, limit_window_seconds: 18000, reset_at: reset }, secondary_window: { used_percent: 100 - weekly, limit_window_seconds: 604800, reset_at: reset } } });
  }
  if (/\/models$/.test(url.pathname) && /^(chatgpt\.com|api\.openai\.com)$/.test(url.hostname)) {
    trace({ type: "discovery", url: url.href });
    return Response.json({ models: [], data: [] });
  }
  const codex = /^(chatgpt\.com|api\.openai\.com)$/.test(url.hostname) && /\/responses$/.test(url.pathname);
  const kimi = /(^|\.)kimi\.(com|ai)$/.test(url.hostname) && /\/messages$/.test(url.pathname);
  if (!codex && !kimi) {
    trace({ type: "unexpected-fetch", url: url.href });
    throw new Error(`fixture forbids unexpected external URL: ${url.href}`);
  }
  const selected = account(headers);
  const serialized = JSON.stringify(body);
  const hookIndex = pending.findIndex((entry) => JSON.stringify(entry.payload) === serialized);
  const hook = hookIndex < 0 ? undefined : pending.splice(hookIndex, 1)[0];
  const child = hook?.kind === "sub"
    ? hook.agentId.toLowerCase().includes("numberedpoolchild") ? "NumberedPoolChild" : hook.agentId.toLowerCase().includes("defaultpoolchild") ? "DefaultPoolChild" : undefined
    : undefined;
  const wireSessionId = hook?.sessionId ?? headers.get("session_id") ?? body?.prompt_cache_key;
  const preflight = !hook && (wireSessionId === "DefaultPoolChild" || wireSessionId === "NumberedPoolChild") ? wireSessionId : undefined;
  const role = child ?? (preflight ? `task-preflight:${preflight}` : serialized.includes("POOL_FIXTURE_NATIVE_TITLE") ? "auxiliary-title" : hook?.kind ?? "main");
  const key = `${role}:${selected}`;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  const signal = init.signal ?? request?.signal;
  let bodyClosed = false;
  trace({ type: "inference", account: selected, role, kind: hook?.kind, sessionId: wireSessionId, sessionHeader: headers.get("session_id"), promptCacheKey: body?.prompt_cache_key, hookSessionId: hook?.sessionId, provider: hook?.provider, model: body?.model, token: headers.get("authorization") ?? headers.get("x-api-key"), accountId: headers.get("chatgpt-account-id"), apiKey: headers.get("x-api-key"), anthropicVersion: headers.get("anthropic-version"), url: url.href, proxy: (init as RequestInit & { proxy?: string }).proxy, attempt });
  signal?.addEventListener("abort", () => trace({ type: bodyClosed ? "post-completion-abort" : "aborted", account: selected, role, sessionId: wireSessionId }), { once: true });
  const failure = current.failures?.[selected];
  if (failure === "limit" || (failure === "transient" && attempt === 1)) {
    return Response.json({ error: { code: failure === "limit" ? "usage_limit_reached" : "rate_limit_exceeded", message: failure === "limit" ? "You have hit your ChatGPT usage limit" : "Too many requests", plan_type: "pro" } }, { status: 429, ...(failure === "transient" ? { headers: { "retry-after": "0.01" } } : {}) });
  }
  const closeBody = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.close();
    bodyClosed = true;
    trace({ type: "closed-stream", account: selected, role, sessionId: wireSessionId });
  };
  const completeSseResponse = (contents: string) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode.encode(contents));
        closeBody(controller);
      },
      cancel() { trace({ type: bodyClosed ? "post-completion-cancel" : "cancelled-stream", account: selected, role, sessionId: wireSessionId }); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  const text = role === "auxiliary-title" ? `<title>POOL_RESPONSE_${selected}</title>` : preflight ? `Fixture task preflight for ${preflight}.` : child ? `${child === "DefaultPoolChild" ? "CHILD_DEFAULT" : "CHILD_NUMBERED"}_${selected}` : `${current.responsePrefix ?? "POOL_RESPONSE"}_${selected}`;
  if (kimi) return completeSseResponse(kimiResponse(text));
  const tool = current.children && !child && !preflight && !serialized.includes('"type":"function_call_output"');
  const { frames, terminal } = responseFrames(text, tool, Boolean(child));
  if (!current.hold || preflight || (current.holdRole ? role !== current.holdRole : Boolean(child)) || tool) return completeSseResponse(frames + terminal);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encode.encode(frames));
      trace({ type: "visible-stream", account: selected, role });
      const timer = setInterval(() => {
        if (!state().release) return;
        clearInterval(timer);
        controller.enqueue(encode.encode(terminal));
        closeBody(controller);
        trace({ type: "released-stream", account: selected, role });
      }, 20);
      signal?.addEventListener("abort", () => clearInterval(timer), { once: true });
    },
    cancel() { trace({ type: bodyClosed ? "post-completion-cancel" : "cancelled-stream", account: selected, role, sessionId: wireSessionId }); },
  }), { headers: { "content-type": "text/event-stream" } });
};

export default function capture(pi: ExtensionAPI) {
  let coordinatorHost: PoolHostBinding | undefined;
  pi.on("session_start", async (_event, ctx) => {
    trace({ type: "session-start", kind: ctx.agent.kind, agentId: ctx.agent.id, sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider });
    if (state().pauseNumbered && ctx.agent.id.toLowerCase().includes("numberedpoolchild")) {
      while (!state().proceedNumbered) await fixtureDelay(20);
    }
    if (ctx.agent.kind === "main") {
      const originalNotify = ctx.ui.notify.bind(ctx.ui);
      ctx.ui.notify = (message, level) => { trace({ type: "notification", message, level }); return originalNotify(message, level); };
      const originalStatus = ctx.ui.setStatus.bind(ctx.ui);
      ctx.ui.setStatus = (key, value) => { trace({ type: "status", key, value }); return originalStatus(key, value); };
      const originalSelect = ctx.ui.select.bind(ctx.ui);
      ctx.ui.select = (title, options, dialogOptions) => {
        trace({ type: "ui-content", text: `${title}\n${options.join("\n")}` });
        return originalSelect(title, options, dialogOptions);
      };
    }
  });
  pi.on("before_provider_request", (event, ctx) => {
    const record = { type: "request-hook", kind: ctx.agent.kind, agentId: ctx.agent.id, sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider, payload: event.payload };
    pending.push(record);
    trace({ ...record, payload: undefined });
    return event.payload;
  });
  pi.on("agent_end", (event, ctx) => trace({ type: "agent-end", kind: ctx.agent.kind, sessionId: ctx.sessionManager.getSessionId(), messages: event.messages }));
  pi.registerCommand("pool-fixture", { description: "Isolated pool regression fixture control", handler: async (args, ctx) => {
    const [action, ...rest] = args.trim().split(/\s+/);
    try {
    if (action === "transport" || action === "unbound-factory") {
      const entries = normalizeEntries(mergeConfigs(loadGlobalConfig(), parseEnvConfig()));
      if (action === "unbound-factory") {
        // Exercise real registration before this new factory receives session_start.
        // Its unbound host must not replace an existing registry-bound native route.
        providers.registerProviderPools(pi, entries, pool.createPoolHostBinding());
        trace({ type: "unbound-factory" });
      } else {
        coordinatorHost ??= pool.createPoolHostBinding();
        pool.bindPoolSession(ctx, coordinatorHost);
        providers.registerProviderPools(pi, entries, coordinatorHost);
      }
      await ctx.modelRegistry.refresh("offline");
      const base = rest[0] ?? "openai-codex";
      const id = rest[1] ?? "gpt-5.5";
      const logical = ctx.modelRegistry.find(pool.poolProviderName(base), id);
      const physical = ctx.modelRegistry.find(base, id);
      if (!logical || !physical) throw new Error(`fixture: transport model missing for ${base}/${id}`);
      const model = providers.getPoolModelForSelection(physical) ?? logical;
      const apiKey = await ctx.modelRegistry.getApiKey(model, ctx.sessionManager.getSessionId());
      trace({ type: "transport-marker", apiKey, provider: model.provider, api: model.api });
      const fetchOverride: typeof globalThis.fetch = rest[2] === "caller-fetch"
        ? async (input, init) => {
          trace({ type: "caller-fetch", url: input instanceof Request ? input.url : String(input), proxy: (init as RequestInit & { proxy?: string } | undefined)?.proxy });
          // This is the caller's real fetch implementation, not a wrapper probe:
          // its most-specific request proxy must reach the fake wire unchanged.
          const explicitProxy = process.env.POOL_FIXTURE_CALLER_PROXY;
          return globalThis.fetch(input, explicitProxy ? { ...init, proxy: explicitProxy } as RequestInit : init);
        }
        : globalThis.fetch;
      const stream = streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "Return the fixture transport response." }], timestamp: Date.now() }] }, {
        apiKey, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, fetch: fetchOverride,
        onPayload(payload, callbackModel) {
          pending.push({ type: "request-hook", kind: ctx.agent.kind, agentId: ctx.agent.id, sessionId: ctx.sessionManager.getSessionId(), provider: callbackModel?.provider, payload });
          trace({ type: "transport-hook", hook: "payload", provider: callbackModel?.provider, model: callbackModel?.id });
          return payload;
        },
        onResponse(response, callbackModel) { trace({ type: "transport-hook", hook: "response", provider: callbackModel?.provider, model: callbackModel?.id, status: response.status }); },
        onSseEvent(_event, callbackModel) { trace({ type: "transport-hook", hook: "sse", provider: callbackModel?.provider, model: callbackModel?.id }); },
      });
      const result = await stream.result();
      trace({ type: "transport-result", result });
    } else if (action === "coordinator" || action === "coordinator-cancel") {
      coordinatorHost ??= pool.createPoolHostBinding();
      pool.bindPoolSession(ctx, coordinatorHost);
      pool.preferPoolMember(ctx, "openai-codex");
      const makeResolver = (signal?: AbortSignal) => {
        let provider: string | undefined;
        const resolver = pool.createPoolResolver(coordinatorHost!, "openai-codex", "gpt-5.5", { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, signal }, (model) => { provider = model.provider; });
        return async () => {
          const resolved = await resolver({ error: undefined, lastChance: false, signal });
          if (!resolved || typeof resolved === "string") throw new Error("fixture: native physical provenance missing");
          trace({ type: "coordinator-selected", provider, credentialId: resolved.credentialId, oauthIdentity: resolved.oauthIdentity, apiKey: resolved.apiKey });
          return resolved;
        };
      };
      if (action === "coordinator") await makeResolver()();
      else {
        const aborted = new AbortController();
        const cancelled = makeResolver(aborted.signal)().then(() => { throw new Error("fixture: aborted caller selected"); }, (error: unknown) => trace({ type: "coordinator-cancelled", error: error instanceof Error ? error.message : String(error) }));
        const healthy = makeResolver()();
        setTimeout(() => aborted.abort(), 25);
        await Promise.all([cancelled, healthy]);
      }
    } else if (action === "auxiliary") {
      const model = ctx.modelRegistry.find("openai-codex-pool", "gpt-5.5");
      if (!model) throw new Error("fixture: pool model missing");
      const { session } = await createAgentSession({
        cwd: ctx.cwd, agentDir: process.env.PI_CODING_AGENT_DIR, model, modelRegistry: ctx.modelRegistry,
        authStorage: ctx.modelRegistry.authStorage, sessionManager: SessionManager.inMemory(ctx.cwd),
        disableExtensionDiscovery: true, extensions: [], skills: [], rules: [], contextFiles: [],
        promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false,
        enableIrc: false, skipPythonPreflight: true, toolNames: [], restrictToolNames: true,
        taskDepth: 1, agentId: "FixtureNativeTitle", bindProcessState: false, cacheWarming: false,
      });
      try {
        const title = await session.generateTitle("Exercise the isolated subscription pool native title route.", "POOL_FIXTURE_NATIVE_TITLE. Return the title inside <title> tags.");
        const traceText = readFileSync(tracePath, "utf8");
        const wire = traceText.slice(0, traceText.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line)).findLast((entry) => entry.type === "inference" && entry.role === "auxiliary-title");
        trace({ type: "auxiliary-result", title, sessionId: wire?.sessionId, ownerSessionId: session.sessionManager.getSessionId() });
      } finally { await session.dispose(); }
    } else if (action === "ambiguity") {
      const model = ctx.modelRegistry.find("openai-codex-pool", "gpt-5.5");
      if (!model) throw new Error("fixture: pool model missing");
      coordinatorHost ??= pool.createPoolHostBinding();
      pool.bindPoolSession(ctx, coordinatorHost);
      const cwd = join(ctx.cwd, "other-policy");
      mkdirSync(join(cwd, ".omp"), { recursive: true });
      writeFileSync(join(cwd, ".omp/multi-auth.json"), JSON.stringify({ allowedSubs: ["openai-codex-2"] }));
      const { session } = await createAgentSession({
        cwd, agentDir: process.env.PI_CODING_AGENT_DIR, model, modelRegistry: ctx.modelRegistry,
        authStorage: ctx.modelRegistry.authStorage, sessionManager: SessionManager.inMemory(cwd),
        disableExtensionDiscovery: true, extensions: [capture], skills: [], rules: [], contextFiles: [],
        promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false,
        enableIrc: false, skipPythonPreflight: true, toolNames: [], restrictToolNames: true,
        taskDepth: 1, agentId: "FixtureOtherPolicy", bindProcessState: false, cacheWarming: false,
      });
      try {
        const binding = session.extensionRunner?.createContext(model);
        if (!binding) throw new Error("fixture: native sibling context unavailable");
        pool.bindPoolSession(binding, coordinatorHost);
        const rootMembers = await pool.listPoolMemberNames(ctx, "openai-codex", model.id);
        const siblingMembers = await pool.listPoolMemberNames(binding, "openai-codex", model.id);
        const rootCwd = ctx.sessionManager.getCwd();
        const siblingCwd = binding.sessionManager.getCwd();
        const sameRegistry = binding.modelRegistry === ctx.modelRegistry;
        const sameRawStorage = binding.modelRegistry.authStorage === ctx.modelRegistry.authStorage;
        const sessionId = "fixture-unrelated-ambiguous";
        const noContextDiagnostic = "multi-auth: missing session context for subscription pool.";
        trace({
          type: "policy-binding", sameRegistry, sameRawStorage, hostMatchesRegistry: coordinatorHost.registry === ctx.modelRegistry,
          root: { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, managerCwd: rootCwd, allowedProviderNames: loadEffectiveConfig(rootCwd).allowedProviderNames ?? null, members: rootMembers, status: pool.getPoolStatus(ctx), provider: ctx.model?.provider, promptCacheKey: ctx.sessionManager.getHeader()?.providerPromptCacheKey ?? null },
          sibling: { sessionId: binding.sessionManager.getSessionId(), cwd: binding.cwd, managerCwd: siblingCwd, allowedProviderNames: loadEffectiveConfig(siblingCwd).allowedProviderNames ?? null, members: siblingMembers, status: pool.getPoolStatus(binding), provider: binding.model?.provider, promptCacheKey: binding.sessionManager.getHeader()?.providerPromptCacheKey ?? null },
          requested: { sessionId, cwd: null, promptCacheKey: null },
        });
        if (!sameRegistry || !sameRawStorage || rootCwd !== ctx.cwd || siblingCwd !== cwd) throw new Error("fixture: native ambiguity sessions do not share the expected registry/storage or retain their independent live cwd");
        if (rootMembers.length !== 2 || !rootMembers.includes("openai-codex") || !rootMembers.includes("openai-codex-2") || siblingMembers.length !== 1 || siblingMembers[0] !== "openai-codex-2") throw new Error("fixture: native ambiguity sessions do not have the expected distinct exact permitted memberships");
        try {
          const resolver = pool.createPoolResolver(coordinatorHost, "openai-codex", model.id, { sessionId }, (member) => {
            trace({ type: "ownership-probe-selected", provider: member.provider, model: member.id });
          });
          const resolved = await resolver({ error: undefined, lastChance: false });
          trace({ type: "ownership-probe", resolved: Boolean(resolved), credentialId: resolved && typeof resolved !== "string" ? resolved.credentialId : undefined });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.endsWith(noContextDiagnostic)) throw error;
          trace({ type: "ownership-probe", error: error.message });
        }
        try {
          const stream = streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "Fixture unowned multi-policy auxiliary request." }], timestamp: Date.now() }] }, { apiKey: await ctx.modelRegistry.getApiKey(model), sessionId });
          const result = await stream.result();
          trace({ type: "ambiguity-result", error: result.errorMessage, stopReason: result.stopReason, boundary: "native-terminal-message" });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.endsWith(noContextDiagnostic)) throw error;
          trace({ type: "ambiguity-result", error: error.message, exceptionName: error.name, boundary: "initial-key-resolution" });
        }
      } finally {
        pool.unbindPoolSession(session.sessionManager.getSessionId());
        await session.dispose();
      }
    } else if (action === "authenticate") {
      const all: unknown = JSON.parse(readFileSync(process.env.POOL_FIXTURE_CREDENTIALS!, "utf8"));
      const value = isObject(all) ? all[rest[0]] : undefined;
      if (!isObject(value) || value.type !== "oauth" || typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") throw new Error("invalid fake OAuth fixture");
      await ctx.modelRegistry.authStorage.credentials.set(rest[0], { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires });
      const row = ctx.modelRegistry.authStorage.credentials.list(rest[0]).find((candidate) => candidate.credential.type === "oauth" && candidate.credential.access === value.access);
      trace({ type: "authenticate", provider: rest[0], credentialId: row?.id });
    } else if (action === "lifecycle-add") {
      coordinatorHost ??= pool.createPoolHostBinding();
      pool.bindPoolSession(ctx, coordinatorHost);
      const dialogCtx = {
        ...ctx, hasUI: false,
        ui: {
          ...ctx.ui,
          notify: ctx.ui.notify.bind(ctx.ui),
          setStatus: ctx.ui.setStatus.bind(ctx.ui),
          select: async (title: string, options: string[]) => {
            trace({ type: "fixture-dialog", title, options });
            const option = options.find((candidate) => candidate.startsWith("openai-codex"));
            if (!option) throw new Error("fixture: Codex add option missing");
            trace({ type: "fixture-dialog-answer", title, answer: option });
            return option;
          },
          input: async (title: string, placeholder?: string) => {
            trace({ type: "fixture-dialog", title, placeholder, answer: "Fixture B" });
            return "Fixture B";
          },
          confirm: async (title: string, message: string) => {
            trace({ type: "fixture-dialog", title, message, answer: false });
            return false;
          },
        },
      };
      await handleSubsAdd(pi, dialogCtx, coordinatorHost);
      trace({ type: "lifecycle-add", provider: "openai-codex-2" });
    } else if (action === "lifecycle-remove") {
      coordinatorHost ??= pool.createPoolHostBinding();
      pool.bindPoolSession(ctx, coordinatorHost);
      const config = loadGlobalConfig();
      const entry = config.subscriptions.find((candidate) => candidate.provider === "openai-codex" && candidate.index === 2);
      if (!entry) throw new Error("fixture: subscription B not configured");
      const dialogCtx = {
        ...ctx, hasUI: false,
        ui: {
          ...ctx.ui, notify: ctx.ui.notify.bind(ctx.ui), setStatus: ctx.ui.setStatus.bind(ctx.ui),
          confirm: async (title: string, message: string) => { trace({ type: "fixture-dialog", title, message, answer: true }); return true; },
        },
      };
      await removeSubscriptionEntry(pi, dialogCtx, config, entry, coordinatorHost);
      trace({ type: "lifecycle-remove", provider: "openai-codex-2" });
    } else if (action === "status") {
      await handleSubsStatus({
        ...ctx, hasUI: false,
        ui: { ...ctx.ui, select: async (title, options) => { trace({ type: "ui-content", text: `${title}\n${options.join("\n")}` }); return undefined; } },
      });
    } else if (action === "precedence") {
      const credentials: unknown = JSON.parse(readFileSync(process.env.POOL_FIXTURE_CREDENTIALS!, "utf8"));
      if (!isObject(credentials) || typeof credentials.externalToken !== "string") throw new Error("invalid external-key fixture");
      const externalToken = credentials.externalToken;
      const storage = ctx.modelRegistry.authStorage;
      if (rest[0] === "runtime") storage.keys.setRuntime("openai-codex", externalToken);
      else if (rest[0] === "config") storage.keys.setConfig("openai-codex", externalToken);
      else if (rest[0] === "environment") process.env.OPENAI_CODEX_OAUTH_TOKEN = externalToken;
      else throw new Error("fixture: unknown precedence source");
      const stored = storage.credentials.get("openai-codex");
      const derivedModel = ctx.modelRegistry.find("openai-codex-pool", "gpt-5.5");
      if (!derivedModel) throw new Error("fixture: derived model missing during native key precedence inspection");
      const derivedApiKey = await ctx.modelRegistry.getApiKey(derivedModel, ctx.sessionManager.getSessionId());
      trace({ type: "precedence-result", source: rest[0], externalToken, derivedApiKey, storedAccess: stored?.type === "oauth" ? stored.access : undefined, storedCredentialIds: storage.credentials.list().map((row) => row.id) });
    } else if (action === "logout") {
      await ctx.modelRegistry.authStorage.credentials.remove(rest[0]);
      trace({ type: "logout", provider: rest[0] });
    } else if (action === "physical-auth") {
      for (const provider of ["openai-codex", "openai-codex-2"]) {
        const definition = getOAuthProvider(provider);
        const resolved = await ctx.modelRegistry.authStorage.keys.resolver(provider, { sessionId: ctx.sessionManager.getSessionId(), modelId: "gpt-5.5" })({ error: undefined, lastChance: false });
        trace({ type: "physical-auth", provider, oauthProviderId: definition?.id, renewableLogin: typeof definition?.login === "function" && typeof definition?.refreshToken === "function", resolved });
      }
    } else if (action === "snapshot") {
      const rows = ctx.modelRegistry.authStorage.credentials.list();
      const config: unknown = Bun.YAML.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "config.yml"), "utf8"));
      if (!isObject(config) || !isObject(config.modelRoles)) throw new Error("fixture: persisted native model roles unavailable");
      const globalConfig = loadGlobalConfig();
      trace({ type: "snapshot", model: ctx.model, modelRoles: config.modelRoles, presets: globalConfig.presets, commands: pi.getCommands(), blocks: ctx.modelRegistry.authStorage.blocks.list(rows.map((row) => row.id)), credentials: rows.map((row) => ({ id: row.id, provider: row.provider, type: row.credential.type, disabledCause: row.disabledCause })), providers: ctx.modelRegistry.getAll().filter((model) => model.id === "gpt-5.5").map((model) => model.provider), subscriptions: globalConfig.subscriptions });
    } else throw new Error(`unknown fixture action: ${action}`);
    } catch (error) {
      trace({ type: "fixture-error", action, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      throw error;
    } finally {
      trace({ type: "command-completed", action });
    }
  } });
}
