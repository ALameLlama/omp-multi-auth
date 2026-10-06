import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createScenarios } from "./fixtures/subscription-pool-scenarios.mjs";
import { createAdvancedScenarios } from "./fixtures/subscription-pool-advanced.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capture = join(root, "tests/fixtures/subscription-pool-capture.ts");
const selected = process.argv.includes("--baseline") ? "baseline" : process.argv.find((arg) => arg.startsWith("--scenario="))?.slice(11);
const keep = process.argv.includes("--prepare-tui");
const extension = join(root, "extensions/multi-auth.ts");
// Native startup discovery can retain a pre-extension fetch reference.
// Contain every OMP process at the OS boundary, including bootstrap and TUI.
const namespaceArgs = ["--user", "--map-root-user", "--net", "--"];
assert.equal(process.platform, "linux", "Subscription pool host fixtures require Linux network namespaces; refusing an uncontained launch.");
const isolation = spawnSync("unshare", [...namespaceArgs, "true"], { encoding: "utf8", timeout: 10_000 });
assert.ok(!isolation.error && isolation.status === 0, `Subscription pool host fixtures require working unshare user/network namespaces; refusing an uncontained launch. ${isolation.error?.message ?? isolation.stderr}`);

function fixtureEnv(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|TERM|COLORTERM|LANG|LC_.*|TZ|TMPDIR|NIX_LD|NIX_LD_LIBRARY_PATH|LD_LIBRARY_PATH)$/.test(key)));
  return { ...env, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "home/.config"), TMPDIR: join(dir, "tmp"), PI_CODING_AGENT_DIR: join(dir, "agent"), POOL_FIXTURE_STATE: join(dir, "state.json"), POOL_FIXTURE_TRACE: join(dir, "trace.jsonl"), POOL_FIXTURE_CREDENTIALS: join(dir, "credentials.json") };
}
function createFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omp-subscription-pool-"));
  try {
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const env = { ...fixtureEnv(dir), ...options.env };
  const state = { quotas: { A: 14, B: 70 }, ...options.state };
  writeFileSync(env.POOL_FIXTURE_STATE, JSON.stringify(state));
  writeFileSync(env.POOL_FIXTURE_TRACE, "");
  writeFileSync(join(agentDir, "multi-auth.json"), JSON.stringify({ subscriptions: options.subscriptions ?? [{ provider: "openai-codex", index: 2, label: "Fixture B" }], presets: options.presets ?? [] }));
  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  task: openai-codex/gpt-5.5\n  tiny: openai-codex-pool/gpt-5.5\nproviders:\n  openaiWebsockets: off\n  openai-codex:\n    codeMode: off\ntask:\n  batch: true\n  isolation:\n    enabled: false\nasync:\n  enabled: false\nretry:\n  enabled: false\n");
  if (options.allowedSubs) {
    mkdirSync(join(cwd, ".omp"));
    writeFileSync(join(cwd, ".omp/multi-auth.json"), JSON.stringify({ allowedSubs: options.allowedSubs }));
  }
  const bootstrap = spawnSync("unshare", [...namespaceArgs, "omp", "--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"], { cwd, env: { ...env, OPENAI_API_KEY: "fixture-bootstrap-only" }, input: '{"id":"bootstrap","type":"get_available_models"}\n', encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(bootstrap.error, undefined, bootstrap.error?.message);
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  const db = new DatabaseSync(join(agentDir, "agent.db"));
  const insert = db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, ?, ?, ?)");
  const rowIds = {};
  const tokens = {};
  const credentials = {};
  const lifetimeMs = options.manualTui ? 86_400_000 : 3_600_000;
  const expires = Date.now() + lifetimeMs;
  for (const [account, provider] of [["A", "openai-codex"], ["B", "openai-codex-2"]]) {
    const claims = { exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: `pool-account-${account.toLowerCase()}`, chatgpt_plan_type: "pro" }, "https://api.openai.com/profile": { email: `pool-${account.toLowerCase()}@example.invalid` } };
    const access = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
    tokens[account] = access;
    credentials[provider] = { type: "oauth", access, refresh: `fixture-refresh-${account}`, expires, accountId: `pool-account-${account.toLowerCase()}` };
    if (options.omitAccounts?.includes(account)) continue;
    rowIds[account] = Number(insert.run(provider, "oauth", JSON.stringify(credentials[provider]), `fixture-${account}`).lastInsertRowid);
  }
  if (options.kimi) {
    for (const [account, provider] of [["A", "kimi-code"], ["B", "kimi-code-2"]]) rowIds[`kimi${account}`] = Number(insert.run(provider, "api_key", JSON.stringify({ key: `pool-kimi-${account.toLowerCase()}` }), null).lastInsertRowid);
  }
  if (options.anthropic) {
    for (const [account, provider] of [["A", "anthropic"], ["B", "anthropic-2"]]) {
      const access = `sk-ant-oat01-fixture-pool-anthropic-${account.toLowerCase()}`;
      tokens[`anthropic${account}`] = access;
      credentials[provider] = { type: "oauth", access, refresh: `fixture-anthropic-refresh-${account}`, expires };
      rowIds[`anthropic${account}`] = Number(insert.run(provider, "oauth", JSON.stringify(credentials[provider]), `fixture-anthropic-${account}`).lastInsertRowid);
    }
  }
  const externalClaims = { exp: Math.floor(expires / 1000), fixture_source: "pool-external-a", "https://api.openai.com/auth": { chatgpt_account_id: "pool-account-a", chatgpt_plan_type: "pro" } };
  credentials.externalToken = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(externalClaims)).toString("base64url")}.external-fixture`;
  writeFileSync(env.POOL_FIXTURE_CREDENTIALS, JSON.stringify(credentials));
  db.close();
  const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session", ...(options.catalog ? [] : ["--model", options.model ?? "openai-codex/gpt-5.5"]), "--extension", extension, "--extension", capture, ...(options.args ?? [])];
  return { dir, cwd, env, args, rowIds, tokens, state,
    update(changes) {
      Object.assign(state, changes);
      const next = `${env.POOL_FIXTURE_STATE}.next`;
      writeFileSync(next, JSON.stringify(state));
      renameSync(next, env.POOL_FIXTURE_STATE);
    },
    traces() {
      const text = readFileSync(env.POOL_FIXTURE_TRACE, "utf8");
      return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    destroy() { rmSync(dir, { recursive: true, force: true }); },
  };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
async function awaitTrace(host, fixture, predicate) {
  const waiter = Promise.withResolvers();
  const scan = () => {
    try {
      const result = fixture.traces().find(predicate);
      if (result) waiter.resolve(result);
    } catch (error) { waiter.reject(error); }
  };
  const watcher = watch(fixture.env.POOL_FIXTURE_TRACE, scan);
  watcher.on("error", waiter.reject);
  scan();
  try {
    return await Promise.race([waiter.promise, host.closed.then(() => { throw new Error("OMP closed before expected trace"); })]);
  } finally { watcher.close(); }
}

class RpcHost {
  constructor(fixture, deadlineAt) {
    this.fixture = fixture;
    this.events = [];
    this.waiters = [];
    this.stderr = "";
    this.nextId = 0;
    this.child = spawn("unshare", [...namespaceArgs, "omp", ...fixture.args], { cwd: fixture.cwd, env: fixture.env });
    const closed = Promise.withResolvers();
    this.closed = closed.promise;
    this.child.once("close", (code, signal) => {
      clearTimeout(this.deadline);
      this.rejectWaiters(new Error(`OMP closed (${code ?? signal})\n${this.stderr}`));
      closed.resolve(code);
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("error", (error) => this.rejectWaiters(error));
    this.child.stdin.on("error", (error) => this.rejectWaiters(error));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      this.events.push(event);
      if (event.type === "extension_ui_request" && ["select", "input", "confirm"].includes(event.method)) {
        this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
      }
      for (let i = this.waiters.length - 1; i >= 0; i--) if (this.waiters[i].matches(event)) this.waiters.splice(i, 1)[0].resolve(event);
    });
    this.deadline = setTimeout(() => {
      const error = new Error(`60-second scenario deadline\n${this.stderr}\n${JSON.stringify(this.events.slice(-8))}`);
      this.rejectWaiters(error);
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    }, Math.max(1, deadlineAt - Date.now()));
  }
  rejectWaiters(error) { for (const waiter of this.waiters.splice(0)) waiter.reject(error); }
  waitFor(matches, start = 0) {
    const existing = this.events.slice(start).find(matches);
    if (existing) return Promise.resolve(existing);
    const waiter = Promise.withResolvers();
    this.waiters.push({ matches, resolve: waiter.resolve, reject: waiter.reject });
    return waiter.promise;
  }
  async send(type, data = {}) {
    const id = `fixture-${++this.nextId}`;
    const response = this.waitFor((event) => event.type === "response" && event.id === id);
    this.child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
    return response;
  }
  async prompt(message) {
    const id = `fixture-${++this.nextId}`;
    const settled = Promise.withResolvers();
    settled.promise.catch(() => {});
    const waiter = {
      matches: (event) => event.type === "agent_end" || (event.type === "response" && event.id === id && event.success === false),
      resolve: (event) => event.type === "agent_end" ? settled.resolve(event) : settled.reject(new Error(event.error ?? JSON.stringify(event))),
      reject: settled.reject,
    };
    this.waiters.push(waiter);
    try {
      const admitted = this.waitFor((event) => event.type === "response" && event.id === id);
      this.child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
      const response = await admitted;
      assert.equal(response.success, true, JSON.stringify(response));
      assert.notEqual(response.data?.agentInvoked, false, "expected inference prompt was consumed without invoking the native agent");
      return await settled.promise;
    } finally {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
    }
  }
  async handledPrompt(message) {
    const before = await this.send("get_messages");
    assert.equal(before.success, true, JSON.stringify(before));
    const start = this.events.length;
    const traceStart = this.fixture.traces().length;
    const inferenceCount = this.fixture.traces().filter((entry) => entry.type === "inference").length;
    const response = await this.send("prompt", { message });
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(response.data?.agentInvoked, false, "denied input did not return the native consumed-input completion");
    const after = await this.send("get_messages");
    assert.equal(after.success, true, JSON.stringify(after));
    assert.deepEqual(after.data.messages, before.data.messages, "consumed input appended a user or agent turn");
    assert.ok(!this.events.slice(start).some((event) => event.type === "agent_start" || event.type === "agent_end"), "consumed input started or completed an agent turn");
    const traces = this.fixture.traces();
    assert.equal(traces.filter((entry) => entry.type === "inference").length, inferenceCount, "consumed input dispatched inference");
    assert.ok(traces.slice(traceStart).some((entry) => entry.type === "notification" && entry.message === "multi-auth: no authenticated allowed pool members for openai-codex/gpt-5.5."), "consumed input omitted the exact no-members notification");
    return response;
  }
  async command(message) {
    const traceStart = this.fixture.traces().length;
    const response = await this.send("prompt", { message });
    assert.equal(response.success, true, JSON.stringify(response));
    if (message.startsWith("/pool-fixture ")) {
      const action = message.split(/\s+/)[1];
      await awaitTrace(this, this.fixture, () => this.fixture.traces().slice(traceStart).some((entry) => entry.type === "command-completed" && entry.action === action));
      const failed = this.fixture.traces().slice(traceStart).find((entry) => entry.type === "fixture-error" && entry.action === action);
      if (failed) throw new Error(failed.error);
    } else if (message.startsWith("/multi-auth switch")) {
      await awaitTrace(this, this.fixture, () => this.fixture.traces().slice(traceStart).some((entry) => entry.type === "notification" && /Switched to|Already using|Failed to switch|not available for switching/.test(entry.message)));
    } else if (message.startsWith("/multi-auth-preset activate ")) {
      await awaitTrace(this, this.fixture, () => this.fixture.traces().slice(traceStart).some((entry) => entry.type === "notification" && entry.message.startsWith('Preset "')));
    } else if (message.startsWith("/multi-auth")) {
      await awaitTrace(this, this.fixture, () => this.fixture.traces().slice(traceStart).some((entry) => ["ui-content", "notification"].includes(entry.type)));
    }
    return response;
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    const code = await this.closed;
    clearTimeout(this.killTimer);
    assert.equal(code, 0, this.stderr);
  }
  async abort() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    await this.closed;
    clearTimeout(this.killTimer);
  }
}

async function scenario(name, options, exercise) {
  const deadlineAt = Date.now() + 60_000;
  const fixture = createFixture(options);
  const host = new RpcHost(fixture, deadlineAt);
  try {
    const models = await host.send("get_available_models");
    assert.equal(models.success, true, JSON.stringify(models));
    if (!options.catalog) {
      const codexIds = models.data.models.filter((model) => model.provider === "openai-codex").map((model) => model.id);
      assert.ok(codexIds.includes("gpt-5.5"), `Required native openai-codex/gpt-5.5 is absent. Available native Codex IDs: ${codexIds.join(", ") || "(none)"}. Use --catalog to inspect this host; do not silently substitute another model.`);
    }
    await exercise(host, fixture, models.data.models);
    await host.close();
    const traces = fixture.traces();
    assert.equal(traces.filter((entry) => entry.type === "unexpected-fetch").length, 0, "unexpected network destination");
    assert.equal(host.events.filter((entry) => entry.type === "extension_error").length, 0, JSON.stringify(host.events));
    console.log(`${name}: ${traces.filter((entry) => entry.type === "inference").map((entry) => `${entry.role}:${entry.account}/${entry.model}`).join(" -> ")}`);
  } catch (error) {
    console.error(JSON.stringify({ scenario: name, traces: fixture.traces(), rpc: host.events.filter((event) => event.type === "extension_error" || event.type === "extension_ui_request" || (event.type === "response" && (event.success === false || event.command === "prompt"))), stderr: host.stderr }, null, 2));
    throw error;
  } finally {
    await host.abort();
    fixture.destroy();
  }
}

function inference(fixture) { return fixture.traces().filter((entry) => entry.type === "inference"); }
function assistantMessages(event) { return (event.messages ?? []).filter((message) => message.role === "assistant"); }
async function pooledState(host) {
  const response = await host.send("get_state");
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.data.model.provider, "openai-codex-pool");
  assert.equal(response.data.model.id, "gpt-5.5");
  return response.data;
}
function assertAccount(fixture, expected) {
  const calls = inference(fixture);
  assert.ok(calls.length > 0, "no actual inference captured");
  assert.deepEqual(calls.map((entry) => entry.account), expected);
  for (const call of calls) {
    assert.notEqual(call.token, "Bearer omp-multi-auth-pool", "pool marker leaked to wire");
    if (call.accountId) {
      assert.equal(call.accountId, `pool-account-${call.account.toLowerCase()}`);
      assert.equal(call.token, `Bearer ${fixture.tokens[call.account]}`);
    }
  }
}
// OMP 18.6.2 Codex fetchWithRetry uses CODEX_MAX_RETRIES=5 before
// returning a typed account-limit error to the native credential driver.
function assertNativeLimitRouting(fixture, failedAccounts, successfulAccounts = []) {
  const calls = inference(fixture);
  let offset = 0;
  const failedPrefix = [];
  for (const account of failedAccounts) {
    const start = offset;
    while (calls[offset]?.account === account) {
      failedPrefix.push(account);
      offset++;
    }
    assert.ok(offset > start && offset - start <= 6, `${account} must have 1–6 bounded native HTTP attempts before rotation, got ${offset - start}`);
  }
  assertAccount(fixture, [...failedPrefix, ...successfulAccounts]);
  return failedPrefix;
}
function assertProvenance(event, id, text) {
  const messages = assistantMessages(event);
  const final = messages.at(-1);
  assert.ok(final, "terminal assistant message missing");
  assert.equal(final.credentialId, id, JSON.stringify(final));
  assert.equal(final.content.filter((part) => part.type === "text").map((part) => part.text).join(""), text);
  assert.notEqual(final.stopReason, "error", final.errorMessage);
}

function assertChildYield(event, text) {
  const assistants = assistantMessages(event);
  assert.equal(assistants.length, 1, "actual child repeated its assistant turn instead of yielding");
  const calls = assistants[0].content.filter((part) => part.type === "toolCall" && part.name === "yield");
  assert.equal(calls.length, 1, "actual child did not invoke the native yield tool exactly once");
  assert.equal(calls[0].arguments.data, text);
  const results = (event.messages ?? []).filter((message) => message.role === "toolResult" && message.toolName === "yield");
  assert.equal(results.length, 1, "native child yield has no execution result");
  assert.equal(results[0].isError, false, "native child yield failed");
}


const cases = {
  baseline: async () => scenario("baseline A14/B70", {}, async (host, fixture) => {
    const result = await host.prompt("Return the fixture response.");
    assertAccount(fixture, ["B"]);
    assertProvenance(result, fixture.rowIds.B, "POOL_RESPONSE_B");
    await pooledState(host);
  }),
};
Object.assign(cases, createScenarios({ scenario, assert, inference, assistantMessages, pooledState, assertAccount, assertProvenance, assertNativeLimitRouting, assertChildYield }));
Object.assign(cases, createAdvancedScenarios({ scenario, assert, inference, assistantMessages, pooledState, assertAccount, assertProvenance, awaitTrace, assertChildYield }));
const coordinatorCases = {
  coordinator: async () => {
    for (const [name, quotas, account] of [
      ["headroom", { A: 14, B: 70 }, "B"],
      ["sticky", { A: 50, B: 90 }, "A"],
      ["both-low", { A: 7, B: 2 }, "A"],
      ["unknown", { A: "missing", B: 70 }, "A"],
    ]) await scenario(`coordinator ${name}`, { state: { quotas } }, async (host, fixture) => {
      await host.command("/pool-fixture coordinator");
      const resolved = fixture.traces().find((entry) => entry.type === "coordinator-selected");
      assert.ok(resolved, "coordinator did not resolve a physical key");
      assert.equal(resolved.provider, account === "A" ? "openai-codex" : "openai-codex-2");
      assert.equal(resolved.credentialId, fixture.rowIds[account]);
      assert.equal(resolved.apiKey, fixture.tokens[account]);
      assert.equal(inference(fixture).length, 0);
      console.log(`${name}: native ${resolved.provider} row ${resolved.credentialId}`);
    });
    await scenario("coordinator independent cancellation", { state: { quotas: { A: 14, B: 70 }, quotaDelayMs: 100 } }, async (host, fixture) => {
      await host.command("/pool-fixture coordinator-cancel");
      assert.ok(fixture.traces().some((entry) => entry.type === "coordinator-cancelled"));
      const selectedKey = fixture.traces().find((entry) => entry.type === "coordinator-selected");
      assert.equal(selectedKey?.credentialId, fixture.rowIds.B);
      assert.equal(selectedKey?.apiKey, fixture.tokens.B);
    });
  },
};
Object.assign(cases, coordinatorCases);
const transportCases = {
  transport: async () => {
    for (const [name, state, expected] of [
      ["headroom", { quotas: { A: 14, B: 70 } }, ["B"]],
      ["native-limit", { quotas: { A: 60, B: 90 }, failures: { A: "limit" } }, ["A", "B"]],
    ]) await scenario(`transport ${name}`, { state }, async (host, fixture) => {
      await host.command("/pool-fixture transport");
      if (name === "native-limit") assertNativeLimitRouting(fixture, ["A"], ["B"]);
      else assertAccount(fixture, expected);
      const result = fixture.traces().find((entry) => entry.type === "transport-result")?.result;
      assertProvenance({ messages: [result] }, fixture.rowIds.B, "POOL_RESPONSE_B");
      assert.equal(result.provider, "openai-codex-pool");
      assert.equal(result.model, "gpt-5.5");
      assert.equal(fixture.traces().find((entry) => entry.type === "transport-marker")?.apiKey, "omp-multi-auth-pool");
    });
    const canonicalProxy = "http://127.0.0.1:18080";
    const globalProxy = "http://127.0.0.1:18081";
    const derivedProxy = "http://127.0.0.1:18082";
    const callerProxy = "http://127.0.0.1:18083";
    for (const [name, env, caller, expected] of [
      ["canonical proxy precedence", { PI_PROXY_OPENAI_CODEX: canonicalProxy, PI_PROXY: globalProxy, PI_PROXY_OPENAI_CODEX_POOL: derivedProxy }, false, canonicalProxy],
      ["canonical global proxy fallback", { PI_PROXY: globalProxy, PI_PROXY_OPENAI_CODEX_POOL: derivedProxy }, false, globalProxy],
      ["caller fetch proxy override", { PI_PROXY_OPENAI_CODEX: canonicalProxy, PI_PROXY: globalProxy, PI_PROXY_OPENAI_CODEX_POOL: derivedProxy, POOL_FIXTURE_CALLER_PROXY: callerProxy }, true, callerProxy],
    ]) await scenario(`transport ${name}`, { env }, async (host, fixture) => {
      await host.command(`/pool-fixture transport openai-codex gpt-5.5${caller ? " caller-fetch" : ""}`);
      assertAccount(fixture, ["B"]);
      const calls = inference(fixture);
      assert.ok(calls.every((entry) => entry.proxy === expected), `${name} did not reach the fake wire with the expected actual init.proxy`);
      const result = fixture.traces().find((entry) => entry.type === "transport-result")?.result;
      assertProvenance({ messages: [result] }, fixture.rowIds.B, "POOL_RESPONSE_B");
      assert.equal(result.provider, "openai-codex-pool");
      assert.equal(result.model, "gpt-5.5");
      if (caller) {
        const overrides = fixture.traces().filter((entry) => entry.type === "caller-fetch");
        assert.equal(overrides.length, calls.length, "the supplied caller fetch implementation was bypassed");
        assert.ok(overrides.every((entry) => entry.proxy === canonicalProxy), "canonical provider proxy was not applied around the caller's fetch");
      }
    });
    await scenario("transport Kimi API key", { kimi: true, subscriptions: [{ provider: "kimi-code", index: 2 }], allowedSubs: ["kimi-code-2"] }, async (host, fixture, models) => {
      const model = models.find((entry) => entry.provider === "kimi-code" && entry.id === "kimi-for-coding") ?? models.find((entry) => entry.provider === "kimi-code");
      assert.ok(model, "native Kimi model missing");
      await host.command(`/pool-fixture transport kimi-code ${model.id}`);
      assertAccount(fixture, ["B"]);
      const result = fixture.traces().find((entry) => entry.type === "transport-result")?.result;
      assertProvenance({ messages: [result] }, fixture.rowIds.kimiB, "POOL_RESPONSE_B");
      assert.equal(result.provider, "kimi-code-pool");
      const call = inference(fixture)[0];
      assert.equal(call.token, "Bearer pool-kimi-b");
      assert.equal(call.apiKey, null, "native Kimi uses bearer authentication, not x-api-key");
      assert.equal(call.anthropicVersion, "2023-06-01");
      assert.match(call.url, /kimi\.(?:com|ai)\/.*messages$/);
    });
  },
};
Object.assign(cases, transportCases);

cases["anthropic-replay"] = async () => scenario("anthropic-replay", {
  anthropic: true,
  catalog: true,
  subscriptions: [{ provider: "anthropic", index: 2, label: "Signed fixture B" }],
}, async (host, fixture, models) => {
  await host.command("/pool-fixture anthropic-replay");
  const traces = fixture.traces();
  const native = traces.find((entry) => entry.type === "anthropic-native-model");
  assert.ok(native, "native signed Anthropic model was not selected");
  assert.equal(native.provider, "anthropic");
  assert.equal(native.api, "anthropic-messages");
  assert.equal(native.reasoning, true);
  assert.equal(native.signingEndpoint, true);
  assert.ok(models.some((model) => model.provider === "anthropic-pool" && model.id === native.id), "real extension did not register the exact signed model pool");
  assertAccount(fixture, ["A", "A", "B"]);
  const calls = inference(fixture);
  assert.equal(calls.length, 3, "native replay duplicated an inference request");
  for (const call of calls) {
    assert.equal(call.model, native.id, "Anthropic transport changed the exact canonical model ID");
    assert.equal(call.token, `Bearer ${fixture.tokens[`anthropic${call.account}`]}`);
    assert.equal(call.apiKey, null, "Anthropic OAuth must use bearer authentication");
    assert.equal(call.anthropicVersion, "2023-06-01");
  }
  const results = traces.filter((entry) => entry.type === "anthropic-replay-result");
  assert.deepEqual(results.map((entry) => entry.turn), [1, 2, 3]);
  for (const [index, account] of ["A", "A", "B"].entries()) {
    const result = results[index].result;
    assertProvenance({ messages: [result] }, fixture.rowIds[`anthropic${account}`], `ANTHROPIC_REPLAY_${account}_${index + 1}`);
    assert.equal(result.provider, "anthropic-pool");
    assert.equal(result.api, "anthropic-messages");
    assert.equal(result.model, native.id);
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.content.filter((part) => part.type === "thinking").map((part) => ({ thinking: part.thinking, signature: part.thinkingSignature })), [{ thinking: `Fixture signed reasoning ${account}.`, signature: `fixture-signature-${account}` }]);
  }
  const contracts = traces.filter((entry) => entry.type === "anthropic-contract");
  assert.deepEqual(contracts.map((entry) => [entry.step, entry.account, entry.error ?? null]), [[1, "A", null], [2, "A", null], [3, "B", null]]);
  assert.deepEqual(contracts[1].signedBlocks.map((block) => ({ type: block.type, thinking: block.thinking, signature: block.signature })), [{ type: "thinking", thinking: "Fixture signed reasoning A.", signature: "fixture-signature-A" }]);
  assert.deepEqual(contracts[2].signedBlocks, [], "native credential B replay retained foreign signed reasoning");
  for (const contract of contracts) {
    assert.ok(["enabled", "adaptive"].includes(contract.thinking.type));
    assert.ok(Number.isInteger(contract.maxTokens) && contract.maxTokens > 1024 && contract.maxTokens <= native.maxTokens);
  }
  const removed = traces.find((entry) => entry.type === "anthropic-removed-A");
  assert.ok(removed);
  assert.ok(!removed.rows.some((row) => row.id === fixture.rowIds.anthropicA));
  assert.ok(removed.rows.some((row) => row.id === fixture.rowIds.anthropicB && row.provider === "anthropic-2"));
  const saved = traces.find((entry) => entry.type === "anthropic-saved-history");
  const after = traces.find((entry) => entry.type === "anthropic-history-after");
  assert.equal(after?.unchanged, true, "pool replay mutated original history");
  assert.deepEqual(after.history, saved.history);
  assert.equal(saved.history.messages[1].provider, "anthropic-pool");
  assert.equal(saved.history.messages[1].credentialId, fixture.rowIds.anthropicA);
  assert.equal(traces.filter((entry) => entry.type === "agent-end").length, 0, "direct native replay unexpectedly invoked or retried an agent turn");
});

if (keep) {
  const fixture = createFixture({ manualTui: true, env: { OMP_SKIP_SETUP: "1" } });
  const env = Object.entries(fixture.env);
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  console.log(`Disposable fixture: ${fixture.dir}`);
  console.log(`cd ${quote(fixture.cwd)} && env -i ${env.map(([key, value]) => `${key}=${quote(value)}`).join(" ")} unshare ${namespaceArgs.map(quote).join(" ")} omp ${fixture.args.filter((arg, index) => index !== 0 && index !== 1).map(quote).join(" ")}`);
  console.log(`After the visual smoke, delete only this fixture: rm -rf -- ${quote(fixture.dir)}`);
} else if (process.argv.includes("--catalog")) {
  await scenario("native catalog", { catalog: true }, async (host, _fixture, models) => {
    const providers = [...new Set(models.filter((model) => model.provider.startsWith("openai-codex")).map((model) => model.provider))].sort();
    for (const provider of providers) console.log(`${provider}: ${models.filter((model) => model.provider === provider).map((model) => model.id).sort().join(", ")}`);
    console.log(`Required fixture model: openai-codex/gpt-5.5 (${models.some((model) => model.provider === "openai-codex" && model.id === "gpt-5.5") ? "available" : "MISSING"}); gpt-5.4 is not substituted automatically.`);
  });
} else if (process.argv.includes("--coordinator")) {
  await coordinatorCases.coordinator();
} else if (process.argv.includes("--transport")) {
  await transportCases.transport();
} else if (selected) {
  assert.ok(cases[selected], `Unknown scenario ${selected}`);
  await cases[selected]();
} else {
  for (const run of Object.values(cases)) await run();
  console.log("subscription pool real-host checks passed");
}
