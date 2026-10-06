// These scenarios drive native RPC, credential APIs, task children and auxiliary
// sessions. Assertions use wire traces, native terminal messages and live state.
export function createAdvancedScenarios(api) {
  const { scenario, assert, inference, assistantMessages, pooledState, assertAccount, assertProvenance, awaitTrace, assertChildYield } = api;
  const cases = {};
  const add = (name, options, run) => { cases[name] = async () => scenario(name, options, run); };
  const terminal = (event, provider = "openai-codex-pool") => {
    const message = assistantMessages(event).at(-1);
    assert.ok(message, "terminal assistant message missing");
    assert.equal(message.provider, provider, "terminal message lost its logical provider");
    assert.equal(message.model, "gpt-5.5", "terminal message changed the exact requested model");
    assert.notEqual(message.stopReason, "error", message.errorMessage);
    return message;
  };
  const respond = async (host, fixture, account, provider = "openai-codex-pool") => {
    const result = await host.prompt("Return the fixture response.");
    assertProvenance(result, fixture.rowIds[account], `POOL_RESPONSE_${account}`);
    terminal(result, provider);
    return result;
  };
  const traceAfter = async (host, fixture, start, predicate) => {
    await awaitTrace(host, fixture, () => fixture.traces().slice(start).some(predicate));
    return fixture.traces().slice(start).find(predicate);
  };
  const commandTrace = async (host, fixture, command, predicate) => {
    const start = fixture.traces().length;
    await host.command(command);
    return traceAfter(host, fixture, start, predicate);
  };
  const snapshot = (host, fixture) => commandTrace(host, fixture, "/pool-fixture snapshot", (entry) => entry.type === "snapshot");
  const modelState = async (host, provider) => {
    const response = await host.send("get_state");
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(response.data.model.provider, provider);
    assert.equal(response.data.model.id, "gpt-5.5");
    return response.data;
  };
  const poolAvailable = async (host, expected) => {
    const response = await host.send("get_available_models");
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(response.data.models.some((model) => model.provider === "openai-codex-pool" && model.id === "gpt-5.5"), expected, "exact-model derived pool registration differs from native catalog");
  };
  const authenticate = async (host, fixture, provider) => {
    const event = await commandTrace(host, fixture, `/pool-fixture authenticate ${provider}`, (entry) => entry.type === "authenticate" && entry.provider === provider);
    assert.ok(Number.isInteger(event.credentialId), "native authentication did not report its real row id");
    return event;
  };
  const noStreamCancellation = (fixture, role) => {
    assert.ok(!fixture.traces().some((entry) => ["aborted", "cancelled-stream"].includes(entry.type) && (!role || entry.role === role)), "an already opened physical stream was aborted or cancelled");
  };

  add("in-flight", { state: { quotas: { A: 50, B: 90 }, children: true, hold: true, holdRole: "DefaultPoolChild", pauseNumbered: true } }, async (host, fixture) => {
    const pending = host.prompt("Exercise the actual parallel task children while the default child's response stays open.");
    // The trace barrier may reject first; retain this rejection for the final await.
    pending.catch(() => {});
    let defaultCall;
    let numberedCall;
    try {
      const visible = await awaitTrace(host, fixture, (entry) => entry.type === "visible-stream" && entry.role === "DefaultPoolChild");
      assert.equal(visible.account, "A");
      defaultCall = inference(fixture).find((entry) => entry.role === "DefaultPoolChild");
      assert.ok(defaultCall?.sessionId, "default child has no native session identity");
      assert.equal(defaultCall.account, "A");
      assert.ok(!inference(fixture).some((entry) => entry.role === "NumberedPoolChild"), "numbered child dispatched before the controlled quota change");
      fixture.update({ quotas: { A: 14, B: 70 }, proceedNumbered: true });
      numberedCall = await awaitTrace(host, fixture, (entry) => entry.type === "inference" && entry.role === "NumberedPoolChild");
      assert.equal(numberedCall.account, "B", "a new child dispatch did not rotate independently of the held request");
      assert.ok(numberedCall.sessionId, "numbered child has no native session identity");
      assert.notEqual(numberedCall.sessionId, defaultCall.sessionId, "actual parallel children reused one session");
      const numberedEnd = await awaitTrace(host, fixture, (entry) => entry.type === "agent-end" && entry.sessionId === numberedCall.sessionId);
      assertProvenance(numberedEnd, fixture.rowIds.B, "CHILD_NUMBERED_B");
      terminal(numberedEnd);
      assert.ok(!fixture.traces().some((entry) => entry.type === "agent-end" && entry.sessionId === defaultCall.sessionId), "held child completed before stream release");
      assert.ok(!fixture.traces().some((entry) => entry.type === "released-stream" && entry.role === "DefaultPoolChild"), "default stream was released before the parallel child completed");
      noStreamCancellation(fixture, "DefaultPoolChild");
    } finally {
      fixture.update({ release: true, proceedNumbered: true });
    }
    const result = await pending;
    assertProvenance(result, fixture.rowIds.B, "POOL_RESPONSE_B");
    terminal(result);
    const traces = fixture.traces();
    const closed = traces.filter((entry) => entry.type === "closed-stream" && entry.role === "DefaultPoolChild" && entry.sessionId === defaultCall.sessionId);
    assert.equal(closed.length, 1, "held physical body must close exactly once after release");
    const visibleIndex = traces.findIndex((entry) => entry.type === "visible-stream" && entry.role === "DefaultPoolChild");
    const closedIndex = traces.findIndex((entry) => entry.type === "closed-stream" && entry.role === "DefaultPoolChild");
    assert.ok(visibleIndex >= 0 && closedIndex > visibleIndex, "physical body closed before its held visible output");
    const defaultEnds = traces.filter((entry) => entry.type === "agent-end" && entry.sessionId === defaultCall.sessionId);
    assert.equal(defaultEnds.length, 1, "held child must terminate exactly once");
    assertProvenance(defaultEnds[0], fixture.rowIds.A, "CHILD_DEFAULT_A");
    terminal(defaultEnds[0]);
    for (const child of [defaultCall, numberedCall]) {
      assert.equal(child.provider, "openai-codex-pool");
      assert.equal(child.model, "gpt-5.5");
      const started = traces.findIndex((entry) => entry.type === "session-start" && entry.sessionId === child.sessionId);
      const dispatched = traces.findIndex((entry) => entry.type === "inference" && entry.sessionId === child.sessionId);
      assert.ok(started >= 0 && started < dispatched, "child dispatched before native session-start binding");
      assert.equal(traces[started].kind, "sub");
      assert.equal(traces[started].provider, "openai-codex-pool");
      const ended = traces.find((entry) => entry.type === "agent-end" && entry.sessionId === child.sessionId);
      assert.ok(ended, `native child end missing for ${child.role}`);
      assertChildYield(ended, child.role === "DefaultPoolChild" ? "CHILD_DEFAULT_A" : "CHILD_NUMBERED_B");
    }
    const allCalls = inference(fixture);
    const preflights = allCalls.filter((entry) => entry.role.startsWith("task-preflight:"));
    const agentCalls = allCalls.filter((entry) => !preflights.includes(entry));
    assert.equal(allCalls.length, 6, "two parent calls, two task preflights and two actual child calls expected");
    assert.deepEqual(preflights.map((entry) => entry.sessionId).sort(), ["DefaultPoolChild", "NumberedPoolChild"]);
    assert.ok(preflights.every((entry) => ["A", "B"].includes(entry.account) && entry.model === "gpt-5.5"), "native task preflight must use an authenticated exact-model pool member");
    assert.deepEqual(agentCalls.map((entry) => entry.account), ["A", "A", "B", "B"], "new child rotation replayed or changed an already-opened agent stream");
    const initialAccounts = allCalls.map((entry) => entry.account);
    assertAccount(fixture, initialAccounts);
    noStreamCancellation(fixture, "DefaultPoolChild");
    await pooledState(host);
    fixture.update({ children: false, hold: false });
    await respond(host, fixture, "B");
    assertAccount(fixture, [...initialAccounts, "B"]);
  });

  for (const action of ["logout", "remove"]) {
    add(`${action}-during-stream`, { state: { quotas: { A: 14, B: 70 }, hold: true } }, async (host, fixture) => {
      const openedId = fixture.rowIds.B;
      const pending = host.prompt("Return the fixture response while the physical account is removed from future dispatches.");
      pending.catch(() => {});
      try {
        const visible = await awaitTrace(host, fixture, (entry) => entry.type === "visible-stream" && entry.account === "B");
        assert.ok(visible, "physical B stream never opened");
        await commandTrace(host, fixture, action === "logout" ? "/pool-fixture logout openai-codex-2" : "/pool-fixture lifecycle-remove", (entry) => entry.type === (action === "logout" ? "logout" : "lifecycle-remove") && entry.provider === "openai-codex-2");
        assert.equal(inference(fixture).length, 1, "credential removal restarted the still-visible request");
        noStreamCancellation(fixture);
      } finally {
        fixture.update({ release: true });
      }
      const result = await pending;
      assertProvenance(result, openedId, "POOL_RESPONSE_B");
      terminal(result);
      assert.equal(fixture.traces().filter((entry) => entry.type === "agent-end" && entry.kind !== "sub").length, 1, "opened turn must terminate exactly once");
      noStreamCancellation(fixture);
      const state = await snapshot(host, fixture);
      assert.ok(!state.credentials.some((row) => row.id === openedId), "native physical credential survived logout/removal");
      assert.equal(state.subscriptions.some((entry) => entry.provider === "openai-codex" && entry.index === 2), action === "logout", "logout/removal changed the wrong subscription lifecycle state");
      fixture.update({ hold: false });
      if (action === "logout") {
        await pooledState(host);
        await respond(host, fixture, "A");
      } else {
        await modelState(host, "openai-codex");
        await poolAvailable(host, false);
        await respond(host, fixture, "A", "openai-codex");
      }
      assertAccount(fixture, ["B", "A"]);
    });
  }

  add("lifecycle", { subscriptions: [], omitAccounts: ["B"], state: { quotas: { A: 50, B: 70 } } }, async (host, fixture) => {
    await modelState(host, "openai-codex");
    await poolAvailable(host, false);
    await respond(host, fixture, "A", "openai-codex");
    await commandTrace(host, fixture, "/pool-fixture lifecycle-add", (entry) => entry.type === "lifecycle-add" && entry.provider === "openai-codex-2");
    await poolAvailable(host, true);
    const added = await snapshot(host, fixture);
    assert.ok(added.subscriptions.some((entry) => entry.provider === "openai-codex" && entry.index === 2), "native add did not persist the new physical subscription");
    assert.ok(!added.credentials.some((row) => row.provider === "openai-codex-2"), "lifecycle add silently authenticated the new physical account");
    const selected = await host.send("set_model", { provider: "openai-codex", modelId: "gpt-5.5" });
    assert.equal(selected.success, true, JSON.stringify(selected));
    await modelState(host, "openai-codex");
    await respond(host, fixture, "A", "openai-codex");
    const authenticated = await authenticate(host, fixture, "openai-codex-2");
    fixture.update({ quotas: { A: 14, B: 70 } });
    const result = await host.prompt("Use the newly authenticated physical account without restarting the host.");
    assertProvenance(result, authenticated.credentialId, "POOL_RESPONSE_B");
    terminal(result);
    await pooledState(host);
    await commandTrace(host, fixture, "/pool-fixture logout openai-codex-2", (entry) => entry.type === "logout" && entry.provider === "openai-codex-2");
    const loggedOut = await snapshot(host, fixture);
    assert.ok(!loggedOut.credentials.some((row) => row.id === authenticated.credentialId), "native logout retained the active credential");
    await respond(host, fixture, "A");
    await pooledState(host);
    await commandTrace(host, fixture, "/pool-fixture lifecycle-remove", (entry) => entry.type === "lifecycle-remove" && entry.provider === "openai-codex-2");
    await modelState(host, "openai-codex");
    await poolAvailable(host, false);
    const removed = await snapshot(host, fixture);
    assert.ok(!removed.subscriptions.some((entry) => entry.provider === "openai-codex"), "final-extra removal left the physical subscription configured");
    assert.ok(removed.credentials.some((row) => row.id === fixture.rowIds.A && row.provider === "openai-codex" && !row.disabledCause), "derived-pool unregistration invalidated the canonical physical credential");
    await respond(host, fixture, "A", "openai-codex");
    assertAccount(fixture, ["A", "A", "B", "A", "A"]);
  });

  add("lifecycle-no-survivor", {}, async (host, fixture) => {
    await respond(host, fixture, "B");
    await commandTrace(host, fixture, "/pool-fixture logout openai-codex-2", (entry) => entry.type === "logout" && entry.provider === "openai-codex-2");
    await commandTrace(host, fixture, "/pool-fixture logout openai-codex", (entry) => entry.type === "logout" && entry.provider === "openai-codex");
    const count = inference(fixture).length;
    const start = fixture.traces().length;
    await host.handledPrompt("This input must be blocked before inference because no authenticated pool member survives.");
    await traceAfter(host, fixture, start, (entry) => entry.type === "notification" && entry.message === "multi-auth: no authenticated allowed pool members for openai-codex/gpt-5.5.");
    assert.equal(inference(fixture).length, count, "empty pool dispatched user input");
    await pooledState(host);
    const empty = await snapshot(host, fixture);
    assert.ok(!empty.credentials.some((row) => ["openai-codex", "openai-codex-2"].includes(row.provider)), "native logout left a pool credential available");
    assert.ok(empty.commands.some((command) => command.name === "multi-auth"), "physical account recovery command disappeared");
    await host.command("/pool-fixture status");
    assert.equal(inference(fixture).length, count, "recovery slash command dispatched inference");
    const authenticated = await authenticate(host, fixture, "openai-codex-2");
    const result = await host.prompt("Return the fixture response after native account recovery.");
    assertProvenance(result, authenticated.credentialId, "POOL_RESPONSE_B");
    terminal(result);
    await pooledState(host);
    assertAccount(fixture, ["B", "B"]);
  });

  add("lifecycle-remove-no-survivor", {}, async (host, fixture) => {
    await respond(host, fixture, "B");
    await commandTrace(host, fixture, "/pool-fixture logout openai-codex", (entry) => entry.type === "logout" && entry.provider === "openai-codex");
    await pooledState(host);
    await commandTrace(host, fixture, "/pool-fixture lifecycle-remove", (entry) => entry.type === "lifecycle-remove" && entry.provider === "openai-codex-2");
    const state = await host.send("get_state");
    assert.equal(state.success, true, JSON.stringify(state));
    assert.equal(state.data.model.id, "gpt-5.5", "final-extra removal changed the requested model id");
    await poolAvailable(host, false);
    const empty = await snapshot(host, fixture);
    assert.ok(!empty.subscriptions.some((entry) => entry.provider === "openai-codex"), "final-extra removal left the account configured");
    assert.ok(!empty.credentials.some((row) => ["openai-codex", "openai-codex-2"].includes(row.provider)), "final-extra removal left a native credential available");
    assert.ok(empty.commands.some((command) => command.name === "multi-auth"), "final-extra removal disabled physical authentication recovery");
    const count = inference(fixture).length;
    const start = fixture.traces().length;
    await host.handledPrompt("This input must be blocked after removing the final authenticated physical account.");
    await traceAfter(host, fixture, start, (entry) => entry.type === "notification" && entry.message === "multi-auth: no authenticated allowed pool members for openai-codex/gpt-5.5.");
    assert.equal(inference(fixture).length, count, "final-extra removal allowed unauthenticated user inference");
    await host.command("/pool-fixture status");
    assert.equal(inference(fixture).length, count, "physical authentication recovery slash command dispatched inference");
    const authenticated = await authenticate(host, fixture, "openai-codex");
    const selected = await host.send("set_model", { provider: "openai-codex", modelId: "gpt-5.5" });
    assert.equal(selected.success, true, JSON.stringify(selected));
    await modelState(host, "openai-codex");
    const result = await host.prompt("Return the fixture response after canonical physical authentication recovery.");
    assertProvenance(result, authenticated.credentialId, "POOL_RESPONSE_A");
    terminal(result, "openai-codex");
    await poolAvailable(host, false);
    assertAccount(fixture, ["B", "A"]);
  });

  add("removed-pool-auth-recovery", { args: ["--thinking", "xhigh"] }, async (host, fixture) => {
    await respond(host, fixture, "B");
    await commandTrace(host, fixture, "/pool-fixture logout openai-codex", (entry) => entry.type === "logout" && entry.provider === "openai-codex");
    await commandTrace(host, fixture, "/pool-fixture lifecycle-remove", (entry) => entry.type === "lifecycle-remove" && entry.provider === "openai-codex-2");
    await poolAvailable(host, false);
    await host.handledPrompt("This input must remain blocked until a real physical credential returns.");
    const authenticated = await authenticate(host, fixture, "openai-codex");
    // Do not set_model here: native authentication alone must recover the stale route.
    const result = await host.prompt("Return the fixture response after canonical authentication alone.");
    assertProvenance(result, authenticated.credentialId, "POOL_RESPONSE_A");
    terminal(result, "openai-codex");
    const state = await modelState(host, "openai-codex");
    assert.equal(state.thinkingLevel, "xhigh", "authentication-only recovery changed thinking level");
    await poolAvailable(host, false);
    assertAccount(fixture, ["B", "A"]);
    assert.equal(fixture.traces().filter((entry) => entry.type === "agent-end" && entry.kind !== "sub").length, 2, "authentication-only recovery duplicated a user turn");
  });

  add("auxiliary", { allowedSubs: ["openai-codex-2"], state: { quotas: { A: 90, B: 7 } } }, async (host, fixture) => {
    await respond(host, fixture, "B");
    const owner = fixture.traces().find((entry) => entry.type === "session-start" && entry.kind === "main");
    assert.ok(owner?.sessionId, "main native session identity missing");
    const start = inference(fixture).length;
    const auxiliary = await commandTrace(host, fixture, "/pool-fixture auxiliary", (entry) => entry.type === "auxiliary-result");
    assert.equal(auxiliary.title, "POOL_RESPONSE_B", "native title generation did not use the only allowed account");
    assert.ok(auxiliary.sessionId, "native title request has no independent wire session identity");
    assert.ok(auxiliary.ownerSessionId, "native auxiliary session manager identity missing");
    assert.notEqual(auxiliary.sessionId, owner.sessionId, "native title request reused the main session identity");
    assert.notEqual(auxiliary.ownerSessionId, owner.sessionId, "native auxiliary reused the main session manager");
    const calls = inference(fixture).slice(start);
    assert.equal(calls.length, 1, "native title generation must issue one independent request");
    assert.equal(calls[0].account, "B");
    assert.equal(calls[0].model, "gpt-5.5");
    assert.ok(!fixture.traces().some((entry) => entry.type === "quota" && entry.account === "A"), "independent title routing ignored the representative project's B-only policy");
    await pooledState(host);
    await respond(host, fixture, "B");
    assertAccount(fixture, ["B", "B", "B"]);
  });

  add("ambiguous-auxiliary", { state: { quotas: { A: 50, B: 90 } } }, async (host, fixture) => {
    await pooledState(host);
    const count = inference(fixture).length;
    const result = await commandTrace(host, fixture, "/pool-fixture ambiguity", (entry) => entry.type === "ambiguity-result");
    assert.equal(typeof result.error, "string", "unowned native dispatch did not return its real terminal diagnostic");
    assert.match(result.error, /multi-auth: missing session context for subscription pool\./, "ambiguous project policies must fail closed with the ownership diagnostic");
    assert.equal(inference(fixture).length, count, "ambiguous unowned request reached physical inference");
    assert.ok(!fixture.traces().some((entry) => entry.type === "quota"), "ambiguous ownership reached physical quota selection");
    await pooledState(host);
    await respond(host, fixture, "A");
    assertAccount(fixture, ["A"]);
  });

  for (const source of ["runtime", "config", "environment"]) {
    add(`${source}-key`, { state: { quotas: { A: 50, B: 90 } } }, async (host, fixture) => {
      const original = await snapshot(host, fixture);
      const storedA = original.credentials.find((row) => row.id === fixture.rowIds.A);
      assert.ok(storedA, "original physical OAuth credential missing");
      assert.equal(storedA.provider, "openai-codex");
      assert.equal(storedA.type, "oauth");
      assert.ok(!storedA.disabledCause, "original physical OAuth credential is disabled");
      const precedence = await commandTrace(host, fixture, `/pool-fixture precedence ${source}`, (entry) => entry.type === "precedence-result" && entry.source === source);
      assert.equal(typeof precedence.externalToken, "string");
      assert.ok(precedence.externalToken.length > 0, "native external key is empty");
      assert.notEqual(precedence.externalToken, fixture.tokens.A, "external bearer must be distinguishable from the stored physical bearer");
      assert.equal(precedence.derivedApiKey, "omp-multi-auth-pool", "canonical external authentication leaked into the separate derived provider");
      assert.equal(precedence.storedAccess, fixture.tokens.A, "native key precedence replaced the physical OAuth credential");
      assert.ok(precedence.storedCredentialIds.includes(fixture.rowIds.A), "native external key setup removed the original physical row");
      assert.ok(precedence.storedCredentialIds.includes(fixture.rowIds.B), "native external key setup removed the numbered physical row");
      if (source === "environment") {
        // The native environment tier is below stored OAuth, unlike runtime/config.
        await respond(host, fixture, "A");
        assertAccount(fixture, ["A"]);
        await commandTrace(host, fixture, "/pool-fixture logout openai-codex", (entry) => entry.type === "logout" && entry.provider === "openai-codex");
      }
      const count = inference(fixture).length;
      const result = await host.prompt("Return the fixture response using native external account-A authentication.");
      const message = terminal(result);
      assert.ok(message.credentialId == null, "rowless external authentication fabricated or borrowed a stored credential id");
      assert.equal(message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), "POOL_RESPONSE_A");
      const calls = inference(fixture).slice(count);
      assert.equal(calls.length, 1, "native external authentication issued unexpected retries");
      assert.equal(calls[0].account, "A");
      assert.equal(calls[0].provider, "openai-codex-pool");
      assert.equal(calls[0].model, "gpt-5.5");
      assert.equal(calls[0].accountId, "pool-account-a");
      assert.equal(calls[0].token, `Bearer ${precedence.externalToken}`, "external authentication did not reach native transport");
      assert.notEqual(calls[0].token, "Bearer omp-multi-auth-pool", "derived marker leaked to physical inference");
      const current = await snapshot(host, fixture);
      const nativeB = current.credentials.find((row) => row.id === fixture.rowIds.B);
      assert.ok(nativeB && nativeB.provider === "openai-codex-2" && nativeB.type === "oauth" && !nativeB.disabledCause, "external key dispatch invalidated the numbered native credential");
      if (source !== "environment") {
        const nativeA = current.credentials.find((row) => row.id === fixture.rowIds.A);
        assert.ok(nativeA && nativeA.provider === storedA.provider && nativeA.type === storedA.type && !nativeA.disabledCause, "external key dispatch invalidated the original physical OAuth row");
      } else {
        assert.ok(!current.credentials.some((row) => row.id === fixture.rowIds.A), "native logout did not remove the stored OAuth tier before environment fallback");
      }
      await pooledState(host);
    });
  }

  return cases;
}
