import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-apikey-"));

try {

	const bootstrap = spawnSync(
		"omp",
		["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"id":"bootstrap","type":"get_available_models"}\n',
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	assert.equal(bootstrap.error, undefined, bootstrap.error?.message);
	assert.equal(bootstrap.status, 0, bootstrap.stderr);

	const db = new DatabaseSync(join(agentDir, "agent.db"));
	const insert = db.prepare(
		"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'api_key', ?, NULL)",
	);
	for (const [provider, key] of [
		["openai-2", "test-openai-key"],
		["deepseek-2", "test-deepseek-key"],
	]) {
		insert.run(provider, JSON.stringify({ key }));
	}
	db.close();

	const child = spawn(
		"omp",
		[
			"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules",
			"--no-lsp", "--no-session", "--extension", join(root, "extensions", "multi-auth.ts"),
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				MULTI_SUB: "openai:1,deepseek:1",
			},
			timeout: 30_000,
		},
	);
	const stdout = [];
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	const waiters = [];
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		stdout.push(line);
		try {
			const event = JSON.parse(line);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (!waiters[i].matches(event)) continue;
				waiters.splice(i, 1)[0].resolve(event);
			}
		} catch {
			// Ignore non-JSON protocol noise or incomplete lines.
		}
	});
	const waitFor = (matches) => new Promise((resolve) => waiters.push({ matches, resolve }));
	const send = async (request) => {
		const response = waitFor((event) => event.id === request.id);
		child.stdin.write(`${JSON.stringify(request)}\n`);
		return response;
	};

	const modelsResponse = await send({ id: "models", type: "get_available_models" });
	const providersResponse = await send({ id: "login-providers", type: "get_login_providers" });
	child.stdin.end();
	const exitCode = await new Promise((resolve) => child.once("close", resolve));
	const rawStdout = stdout.join("\n");
	const rawStderr = Buffer.concat(stderr).toString();
	assert.equal(exitCode, 0, rawStderr);
	assert.doesNotMatch(rawStdout, /"type":"extension_error"/, rawStdout);
	assert.equal(modelsResponse.command, "get_available_models");
	assert.equal(modelsResponse.success, true);
	assert.equal(providersResponse.command, "get_login_providers");
	assert.equal(providersResponse.success, true);

	for (const [provider, baseUrl] of [
		["openai-2", "https://api.openai.com/v1"],
		["deepseek-2", "https://api.deepseek.com"],
	]) {
		const providerModels = modelsResponse.data.models.filter((model) => model.provider === provider);
		assert.ok(providerModels.length > 0, `missing models for ${provider}`);
		assert.ok(providerModels.every((model) => model.baseUrl === baseUrl));
		console.log(`${provider} models: ${providerModels.length}`);
	}

	const providers = providersResponse.data.providers ?? providersResponse.data;
	assert.ok(Array.isArray(providers), "login providers response must contain an array");
	const providerIds = providers.map((provider) => typeof provider === "string" ? provider : provider.id);
	assert.ok(providerIds.includes("openai-2"), "missing openai-2 login provider");
	assert.ok(providerIds.includes("deepseek-2"), "missing deepseek-2 login provider");
	console.log("API-key provider check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
