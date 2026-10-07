export function createScenarios(api) {
  const { scenario, assert, inference, assistantMessages, pooledState, assertAccount, assertProvenance, assertNativeLimitRouting, assertChildYield } = api;
  const cases = {};
  const add = (name, options, run) => { cases[name] = async () => scenario(name, options, run); };
  const logicalProvenance = (event, provider = "openai-codex-pool", modelId = "gpt-5.5") => {
    const final = assistantMessages(event).at(-1);
    assert.ok(final, "terminal assistant message missing");
    assert.equal(final.provider, provider, "terminal message lost the logical pool provider");
    assert.equal(final.model, modelId, "terminal message changed the requested model");
  };
  const respond = async (host, fixture, account, prompt = "Return the fixture response.") => {
    const result = await host.prompt(prompt);
    assertProvenance(result, fixture.rowIds[account], `POOL_RESPONSE_${account}`);
    logicalProvenance(result);
    await pooledState(host);
    return result;
  };
  const snapshot = async (host, fixture) => {
    const start = fixture.traces().length;
    await host.command("/pool-fixture snapshot");
    const record = fixture.traces().slice(start).find((entry) => entry.type === "snapshot");
    assert.ok(record, "fixture snapshot command did not run");
    return record;
  };
  const terminalError = (result) => {
    const message = assistantMessages(result).at(-1);
    assert.ok(message, "terminal assistant error missing");
    assert.equal(message.stopReason, "error", JSON.stringify(message));
    assert.ok(message.errorMessage, "terminal error has no diagnostic");
    return message;
  };
  const checkChildren = (fixture, account, prelude = []) => {
    const traces = fixture.traces();
    const allCalls = inference(fixture);
    const preflights = allCalls.filter((entry) => entry.role.startsWith("task-preflight:"));
    const calls = allCalls.filter((entry) => !preflights.includes(entry));
    assert.equal(calls.length, 4 + prelude.length, "prior requests/native attempts, parent tool call, two actual children, and parent completion expected");
    assert.deepEqual(preflights.map((entry) => entry.sessionId).sort(), ["DefaultPoolChild", "NumberedPoolChild"], "actual task preflight must run once for each independent unowned child identity");
    assertAccount(fixture, [...prelude, ...Array(6).fill(account)]);
    const children = calls.filter((entry) => ["DefaultPoolChild", "NumberedPoolChild"].includes(entry.role));
    assert.deepEqual(children.map((entry) => entry.role).sort(), ["DefaultPoolChild", "NumberedPoolChild"]);
    assert.equal(new Set(children.map((entry) => entry.sessionId)).size, 2, "children must have independent real sessions");
    for (const child of children) {
      assert.ok(child.sessionId, "child inference has no session identity");
      assert.equal(child.provider, "openai-codex-pool");
      assert.equal(child.model, "gpt-5.5");
      const startIndex = traces.findIndex((entry) => entry.type === "session-start" && entry.sessionId === child.sessionId);
      assert.ok(startIndex >= 0, `no session-start for ${child.role}`);
      assert.equal(traces[startIndex].kind, "sub");
      assert.equal(traces[startIndex].provider, "openai-codex-pool", "child must bind its pool before its first prompt");
      const inferenceIndex = traces.findIndex((entry) => entry.type === "inference" && entry.sessionId === child.sessionId && entry.role === child.role);
      assert.ok(startIndex < inferenceIndex, "child inference preceded its session-start binding");
      const preflight = preflights.find((entry) => entry.sessionId === child.role);
      assert.ok(preflight, `native preflight missing for ${child.role}`);
      assert.equal(preflight.model, "gpt-5.5");
      assert.notEqual(preflight.sessionId, child.sessionId);
      const preflightIndex = traces.findIndex((entry) => entry.type === "inference" && entry.role === preflight.role && entry.sessionId === preflight.sessionId);
      assert.ok(preflightIndex >= 0 && preflightIndex < startIndex, "native task preflight must precede its actual child binding");
      const ended = traces.find((entry) => entry.type === "agent-end" && entry.sessionId === child.sessionId);
      assert.ok(ended, `no native agent-end for ${child.role}`);
      const text = `${child.role === "DefaultPoolChild" ? "CHILD_DEFAULT" : "CHILD_NUMBERED"}_${account}`;
      assertProvenance(ended, fixture.rowIds[account], text);
      logicalProvenance(ended);
      assertChildYield(ended, text);
    }
    const parentCalls = calls.filter((entry) => !children.includes(entry));
    assert.equal(parentCalls.length, 2 + prelude.length);
    assert.ok(parentCalls.every((entry) => entry.model === "gpt-5.5"), "native parent wire requests changed the exact model");
    const parentStarts = traces.filter((entry) => entry.type === "session-start" && entry.kind === "main");
    assert.equal(parentStarts.length, 1, "actual parent session binding missing or duplicated");
    assert.equal(parentStarts[0].provider, "openai-codex-pool");
    assert.ok(parentCalls.every((entry) => entry.sessionId === parentStarts[0].sessionId), "native HTTP retries lost their actual parent session identity");
    // Logical provider identity belongs to native request hooks and terminal
    // messages, not HTTP bodies. Internal fetch retries need not rerun hooks.
    const parentHooks = traces.filter((entry) => entry.type === "request-hook" && entry.kind === "main" && entry.sessionId === parentStarts[0].sessionId);
    assert.ok(parentHooks.length >= 2, "both actual parent turns must emit native request hooks");
    assert.ok(parentHooks.every((entry) => entry.provider === "openai-codex-pool"), "native parent request hook lost the logical pool identity");
    const parentEnd = traces.find((entry) => entry.type === "agent-end" && entry.kind === "main" && entry.sessionId === parentStarts[0].sessionId);
    assert.ok(parentEnd, "actual parent terminal event missing");
    logicalProvenance(parentEnd);
    assert.ok(parentCalls.every((entry) => !children.some((child) => child.sessionId === entry.sessionId)), "child reused parent session identity");
  };

  add("thinking-preserved", { args: ["--thinking", "xhigh"] }, async (host, fixture) => {
    const before = await pooledState(host);
    assert.equal(before.thinkingLevel, "xhigh", "pool promotion changed the selected thinking level");
    const saved = await snapshot(host, fixture);
    assert.equal(saved.modelRoles.task, "openai-codex/gpt-5.5", "saved task role must retain its physical selector");
    await respond(host, fixture, "B");
    const after = await pooledState(host);
    assert.equal(after.thinkingLevel, "xhigh", "pooled dispatch changed the selected thinking level");
    assertAccount(fixture, ["B"]);
    const completed = await snapshot(host, fixture);
    assert.equal(completed.modelRoles.task, "openai-codex/gpt-5.5", "routing rewrote the persisted task role");
    assert.deepEqual(completed.modelRoles, saved.modelRoles, "routing changed saved agent roles");
  });

  add("unbound-factory", {}, async (host, fixture) => {
    await pooledState(host);
    await host.command("/pool-fixture unbound-factory");
    assert.ok(fixture.traces().some((entry) => entry.type === "unbound-factory"), "real unbound factory registration did not run");
    assertAccount(fixture, ["B"]);
    const result = fixture.traces().find((entry) => entry.type === "transport-result")?.result;
    assertProvenance({ messages: [result] }, fixture.rowIds.B, "POOL_RESPONSE_B");
    logicalProvenance({ messages: [result] });
    await pooledState(host);
  });

  add("sticky", { state: { quotas: { A: 50, B: 90 } } }, async (host, fixture) => {
    await respond(host, fixture, "A");
    await respond(host, fixture, "A", "Return the fixture response again.");
    assertAccount(fixture, ["A", "A"]);
    assert.ok(fixture.traces().filter((entry) => entry.type === "quota" && entry.account === "A").length >= 2, "active quota must be refreshed for each dispatch");
  });

  for (const [name, a, expected] of [["threshold-exact", 15, "B"], ["threshold-above", 15.01, "A"]]) {
    add(name, { state: { quotas: { A: a, B: 70 } } }, async (host, fixture) => {
      await respond(host, fixture, expected);
      assertAccount(fixture, [expected]);
    });
  }
  for (const [name, a] of [["short-window", [14, 90]], ["weekly-window", [90, 14]]]) {
    add(name, { state: { quotas: { A: a, B: [70, 70] } } }, async (host, fixture) => {
      await respond(host, fixture, "B");
      assertAccount(fixture, ["B"]);
    });
  }
  for (const [name, a, b] of [["all-low", 14, 7], ["below-native-reserve", 7, 2]]) {
    add(name, { state: { quotas: { A: a, B: b } } }, async (host, fixture) => {
      await respond(host, fixture, "A");
      assertAccount(fixture, ["A"]);
    });
  }
  add("all-low-equal", { state: { quotas: { A: 14, B: 70 } } }, async (host, fixture) => {
    await respond(host, fixture, "B");
    fixture.update({ quotas: { A: 7, B: 7 } });
    await respond(host, fixture, "B");
    assertAccount(fixture, ["B", "B"]);
  });

  add("quota-unknown", { state: { quotas: { A: "missing", B: "missing" } } }, async (host, fixture) => {
    await respond(host, fixture, "A");
    await respond(host, fixture, "A");
    assertAccount(fixture, ["A", "A"]);
  });
  for (const quota of ["missing", "failed"]) {
    add(`quota-${quota}`, { state: { quotas: { A: quota, B: 70 } } }, async (host, fixture) => {
      await respond(host, fixture, "A");
      fixture.update({ quotas: { A: 14, B: quota } });
      await respond(host, fixture, "B");
      await respond(host, fixture, "B");
      assertAccount(fixture, ["A", "B", "B"]);
    });
  }

  add("native-limit", { state: { quotas: { A: 60, B: 90 }, failures: { A: "limit" } } }, async (host, fixture) => {
    await respond(host, fixture, "B");
    assertNativeLimitRouting(fixture, ["A"], ["B"]);
    assert.equal(fixture.traces().filter((entry) => entry.type === "agent-end" && entry.kind !== "sub").length, 1, "native credential failover duplicated the user turn");
    const state = await snapshot(host, fixture);
    assert.ok(state.blocks.some((block) => block.credentialId === fixture.rowIds.A), "native usage limit must block the genuine failing credential");
    assert.ok(!state.blocks.some((block) => block.credentialId === fixture.rowIds.B), "successful B credential was incorrectly blocked");
    await respond(host, fixture, "B");
    assertNativeLimitRouting(fixture, ["A"], ["B", "B"]);
    assert.equal(fixture.traces().filter((entry) => entry.type === "agent-end" && entry.kind !== "sub").length, 2, "subsequent input duplicated a logical user turn");
  });
  add("both-exhausted", { state: { quotas: { A: 60, B: 90 }, failures: { A: "limit", B: "limit" } } }, async (host, fixture) => {
    const result = await host.prompt("Return the fixture response.");
    const error = terminalError(result);
    assert.equal(error.credentialId, fixture.rowIds.B, "terminal exhaustion lost the actual final physical credential");
    logicalProvenance(result);
    assertNativeLimitRouting(fixture, ["A", "B"]);
    await pooledState(host);
    const state = await snapshot(host, fixture);
    for (const account of ["A", "B"]) assert.ok(state.blocks.some((block) => block.credentialId === fixture.rowIds[account]), `${account} native credential was not blocked`);
    assert.equal(fixture.traces().filter((entry) => entry.type === "agent-end" && entry.kind !== "sub").length, 1, "usage exhaustion replayed the logical user turn");
  });
  add("transient", { state: { quotas: { A: 60, B: 90 }, failures: { A: "transient" } } }, async (host, fixture) => {
    const result = await host.prompt("Return the fixture response.");
    const last = assistantMessages(result).at(-1);
    if (last?.stopReason === "error") terminalError(result);
    else assertProvenance(result, fixture.rowIds.A, "POOL_RESPONSE_A");
    logicalProvenance(result);
    const firstCalls = inference(fixture);
    assert.ok(firstCalls.length > 0, "transient scenario did not dispatch a real request");
    assertAccount(fixture, Array(firstCalls.length).fill("A"));
    await respond(host, fixture, "A");
    assertAccount(fixture, Array(firstCalls.length + 1).fill("A"));
    const state = await snapshot(host, fixture);
    assert.ok(!state.blocks.some((block) => block.credentialId === fixture.rowIds.A), "transient request limit was persisted as account exhaustion");
  });

  add("children", { state: { quotas: { A: 14, B: 70 }, children: true } }, async (host, fixture) => {
    await respond(host, fixture, "B", "Exercise both actual task children and return the fixture response.");
    checkChildren(fixture, "B");
  });
  add("shared-sticky-children", { state: { quotas: { A: 14, B: 70 } } }, async (host, fixture) => {
    await respond(host, fixture, "B");
    assertAccount(fixture, ["B"]);
    fixture.update({ quotas: { A: 60, B: 70 }, children: true });
    await respond(host, fixture, "B", "Exercise both actual task children while retaining the already active B account despite healthy A.");
    checkChildren(fixture, "B", ["B"]);
    assertAccount(fixture, Array(7).fill("B"));
    assert.equal(fixture.traces().filter((entry) => entry.type === "agent-end" && entry.kind === "main").length, 2, "shared sticky routing duplicated a main user turn");
    const state = await snapshot(host, fixture);
    assert.ok(!state.blocks.some((block) => block.credentialId === fixture.rowIds.A), "sticky B routing was masked by a native block on healthy A");
  });
  add("native-limit-children", { state: { quotas: { A: 60, B: 90 }, failures: { A: "limit" }, children: true } }, async (host, fixture) => {
    await respond(host, fixture, "B", "Exercise both actual task children after native account failover.");
    const failedPrefix = assertNativeLimitRouting(fixture, ["A"], Array(6).fill("B"));
    checkChildren(fixture, "B", failedPrefix);
    const state = await snapshot(host, fixture);
    assert.ok(state.blocks.some((block) => block.credentialId === fixture.rowIds.A), "children lost the genuine failing credential's native block");
    fixture.update({ children: false });
    await respond(host, fixture, "B", "Return the fixture response again after both children.");
    assertNativeLimitRouting(fixture, ["A"], Array(7).fill("B"));
  });
  add("project-children", { allowedSubs: ["openai-codex-2"], state: { quotas: { A: 90, B: 7 }, children: true } }, async (host, fixture) => {
    await respond(host, fixture, "B", "Exercise both actual task children under the project allow-list.");
    checkChildren(fixture, "B");
    assert.ok(!fixture.traces().some((entry) => entry.type === "quota" && entry.account === "A"), "disallowed A was considered by the project pool");
  });

  add("no-members", { allowedSubs: ["openai-codex-2"], state: { quotas: { A: 90, B: 70 } } }, async (host, fixture) => {
    await host.command("/pool-fixture logout openai-codex-2");
    await host.handledPrompt("This prompt must be blocked before inference.");
    const state = await snapshot(host, fixture);
    assert.equal(inference(fixture).length, 0, "empty allowed pool dispatched inference");
    assert.ok(fixture.traces().some((entry) => entry.type === "notification" && entry.message === "multi-auth: no authenticated allowed pool members for openai-codex/gpt-5.5."), "empty pool had no explicit diagnostic");
    assert.ok(state.commands.some((command) => command.name === "multi-auth"), "physical account recovery command is unavailable");
    await host.command("/pool-fixture status");
    assert.equal(inference(fixture).length, 0, "account status dispatched inference");
    await host.command("/pool-fixture authenticate openai-codex-2");
    const authenticated = fixture.traces().filter((entry) => entry.type === "authenticate" && entry.provider === "openai-codex-2").at(-1);
    assert.ok(authenticated, "fixture native authentication did not complete");
    assert.ok(Number.isInteger(authenticated.credentialId), "native authentication did not report its real credential id");
    const result = await host.prompt("Return the fixture response after account recovery.");
    assertAccount(fixture, ["B"]);
    assertProvenance(result, authenticated.credentialId, "POOL_RESPONSE_B");
    logicalProvenance(result);
    await pooledState(host);
  });

  add("kimi", { kimi: true, subscriptions: [{ provider: "kimi-code", index: 2, label: "Fixture Kimi B" }], allowedSubs: ["kimi-code-2"] }, async (host, fixture, models) => {
    const available = models.filter((model) => model.provider === "kimi-code");
    const model = available.find((candidate) => candidate.id === "kimi-for-coding") ?? available[0];
    assert.ok(model, "installed native catalog has no Kimi Code model");
    const selected = await host.send("set_model", { provider: "kimi-code", modelId: model.id });
    assert.equal(selected.success, true, JSON.stringify(selected));
    const result = await host.prompt("Return the fixture response using native Kimi transport.");
    assertAccount(fixture, ["B"]);
    assertProvenance(result, fixture.rowIds.kimiB, "POOL_RESPONSE_B");
    logicalProvenance(result, "kimi-code-pool", model.id);
    const state = await host.send("get_state");
    assert.equal(state.success, true, JSON.stringify(state));
    assert.equal(state.data.model.provider, "kimi-code-pool");
    assert.equal(state.data.model.id, model.id);
    const [call] = inference(fixture);
    assert.equal(call.provider, "kimi-code-pool");
    assert.equal(call.model, model.id);
    assert.match(call.url, /^https:\/\/(?:[^/]+\.)?kimi\.(?:com|ai)\/.*messages$/);
    assert.equal(call.token, "Bearer pool-kimi-b");
    assert.equal(call.apiKey, null, "native Kimi uses bearer authentication, not x-api-key");
    assert.equal(call.anthropicVersion, "2023-06-01", "Kimi did not use its native messages API headers");
  });

  add("physical-auth", {}, async (host, fixture) => {
    await pooledState(host);
    for (const [account, provider] of [["A", "openai-codex"], ["B", "openai-codex-2"]]) {
      const start = fixture.traces().length;
      await host.command(`/pool-fixture physical-auth ${provider}`);
      const record = fixture.traces().slice(start).find((entry) => entry.type === "physical-auth" && entry.provider === provider);
      assert.ok(record, `native physical auth observation missing for ${provider}`);
      assert.equal(record.resolved?.credentialId, fixture.rowIds[account], "physical native resolver lost the original credential row");
      assert.equal(record.resolved.apiKey, fixture.tokens[account], "physical native resolver received the derived pool marker");
    }
    const state = await snapshot(host, fixture);
    assert.ok(!state.credentials.some((row) => row.provider.endsWith("-pool")), "pool activation created a migrated credential row");
    assert.equal(inference(fixture).length, 0, "physical OAuth registry inspection dispatched inference");
  });

  add("compatibility", { state: { quotas: { A: 50, B: 90 } } }, async (host, fixture) => {
    await respond(host, fixture, "A");
    await respond(host, fixture, "A");
    const warnings = host.events.filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify" && /Code Mode/.test(entry.message) && /\/fast/.test(entry.message));
    assert.equal(warnings.length, 1, "Codex pool compatibility warning must appear once per session");
    assert.match(warnings[0].message, /unavailable|not available|unsupported/i);
    assert.equal(warnings[0].notifyType, "warning");
    const start = fixture.traces().length;
    await host.command("/pool-fixture status");
    const rendered = fixture.traces().slice(start).filter((entry) => entry.type === "ui-content").map((entry) => entry.text).join("\n");
    assert.match(rendered, /Code Mode/);
    assert.match(rendered, /\/fast/);
    assert.match(rendered, /unavailable|not available|unsupported/i);
    assert.match(rendered, /openai-codex-pool/, "status omitted the derived pool identity");
    assert.match(rendered, /openai-codex-2|Fixture B/, "status omitted the numbered physical account");
    assert.match(rendered, /15%/, "status omitted the soft headroom threshold");
    const state = await snapshot(host, fixture);
    assert.equal(state.model.provider, "openai-codex-pool");
    const native = await pooledState(host);
    assert.equal(native.fastModeActive, false, "pooled Codex falsely activated native fast mode");
    assertAccount(fixture, ["A", "A"]);
  });

  add("pool-status", { state: { quotas: { A: 50, B: 90 } } }, async (host, fixture) => {
    await respond(host, fixture, "A");
    const status = () => fixture.traces().findLast((entry) => entry.type === "status" && entry.key === "multi-auth-pool")?.value;
    const first = status();
    assert.equal(typeof first, "string", "pool status line was not rendered");
    assert.match(first, /openai-codex/);
    assert.match(first, /2 accounts/);
    assert.match(first, /15% headroom/);
    const start = fixture.traces().length;
    fixture.update({ quotas: { A: 14, B: 70 } });
    await respond(host, fixture, "B");
    const switched = status();
    assert.match(switched, /openai-codex-2|Fixture B/, "quota-driven rotation left the active-account status stale");
    assert.match(switched, /2 accounts/);
    assert.match(switched, /15% headroom/);
    assert.ok(fixture.traces().slice(start).some((entry) => entry.type === "notification" && /openai-codex/.test(entry.message) && /openai-codex-2/.test(entry.message) && /15% headroom/.test(entry.message)), "actual headroom rotation omitted its physical old/new account notification");
    assertAccount(fixture, ["A", "B"]);
    await pooledState(host);
  });
  const physicalPreset = { name: "FixturePhysical", enabled: true, entries: [{ provider: "openai-codex-2", model: "gpt-5.5", enabled: true }] };
  add("preset", { presets: [physicalPreset], args: ["--thinking", "xhigh"] }, async (host, fixture) => {
    const selected = await host.send("set_model", { provider: "openai-codex-2", modelId: "gpt-5.5" });
    assert.equal(selected.success, true, JSON.stringify(selected));
    const before = await snapshot(host, fixture);
    assert.deepEqual(before.presets, [physicalPreset], "fixture physical preset was not persisted with the existing schema");
    const start = fixture.traces().length;
    await host.command("/multi-auth-preset activate FixturePhysical");
    const state = await pooledState(host);
    assert.equal(state.thinkingLevel, "xhigh", "preset activation changed the selected thinking level");
    const notice = fixture.traces().slice(start).find((entry) => entry.type === "notification" && entry.message.startsWith('Preset "FixturePhysical":'));
    assert.ok(notice, "actual named preset activation did not finish");
    assert.match(notice.message, /switched to.*pool/i, "preset success notification reported a pinned physical provider instead of the selected pool");
    assert.match(notice.message, /gpt-5\.5/, "preset notification changed the exact model identity");
    assert.equal(inference(fixture).length, 0, "preset activation dispatched a model request before the user prompt");
    const activated = await snapshot(host, fixture);
    assert.deepEqual(activated.presets, [physicalPreset], "activation rewrote the saved physical preset selector");
    await respond(host, fixture, "B");
    assertAccount(fixture, ["B"]);
    const completed = await snapshot(host, fixture);
    assert.deepEqual(completed.presets, [physicalPreset], "pooled inference rewrote the saved physical preset selector");
    assert.equal((await pooledState(host)).thinkingLevel, "xhigh");
  });

  add("switch", { args: ["--thinking", "xhigh"], state: { quotas: { A: 50, B: 90 } } }, async (host, fixture) => {
    await respond(host, fixture, "A");
    const start = fixture.traces().length;
    await host.command("/multi-auth switch openai-codex-2");
    const state = await host.send("get_state");
    assert.equal(state.success, true, JSON.stringify(state));
    assert.equal(state.data.thinkingLevel, "xhigh", "subscription switch changed the selected thinking level");
    assert.equal(state.data.model.provider, "openai-codex-2", "physical switch was re-promoted to the pool instead of pinning");
    assert.equal(state.data.model.id, "gpt-5.5", "subscription switch changed the selected model");
    const notice = fixture.traces().slice(start).find((entry) => entry.type === "notification" && /switched/i.test(entry.message));
    assert.ok(notice, "subscription switch did not confirm the new physical selection");
    const result = await host.prompt("Return the fixture response.");
    assertProvenance(result, fixture.rowIds.B, "POOL_RESPONSE_B");
    const final = assistantMessages(result).at(-1);
    assert.equal(final.provider, "openai-codex-2", "pinned physical selection lost its physical provider identity");
    assertAccount(fixture, ["A", "B"]);
  });

  return cases;
}
