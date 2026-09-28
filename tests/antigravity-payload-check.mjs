import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "multi-auth.ts");

async function runCapture(model, subscriptions) {
	const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-antigravity-"));
	const capturePath = join(agentDir, "capture.json");
	const captureExtension = join(agentDir, "capture.ts");
	let child;
	let childClosed;
	try {
		writeFileSync(
			captureExtension,
			`import { writeFileSync } from "node:fs";\nlet eventPayload;\nconst originalFetch = globalThis.fetch;\nglobalThis.fetch = async (input, init) => {\n  const wireBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;\n  writeFileSync(process.env.MP_CAPTURE, JSON.stringify({ provider: eventPayload?.provider, payload: eventPayload?.payload, wire: { url: String(input), headers: init?.headers, body: wireBody } }));\n  setTimeout(() => process.exit(0), 25);\n  return originalFetch("data:,", { headers: { "content-type": "text/event-stream" } });\n};\nexport default function capture(pi) {\n  pi.on("before_provider_request", (event, ctx) => {\n    eventPayload = { provider: ctx.model?.provider, payload: event.payload };\n    return event.payload;\n  });\n}\n`,
		);
		writeFileSync(
			join(agentDir, "multi-auth.json"),
			JSON.stringify({ subscriptions, presets: [] }),
		);
		const bootstrap = spawnSync(
			"omp",
			["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"],
			{ cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 30_000 },
		);
		assert.equal(bootstrap.status, 0, bootstrap.stderr);
		child = spawn(
			"omp",
			[
				"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session",
				"--model", model,
				"--api-key", JSON.stringify({ token: "test-token", projectId: "aicode-consumers" }),
				"--extension", extension,
				"--extension", captureExtension,
			],
			{ cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MP_CAPTURE: capturePath } },
		);
		childClosed = new Promise((resolve) => child.once("close", resolve));
		const stdout = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		const stderr = [];
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.stdin.write('{"id":"capture","type":"prompt","message":"say hi"}\n');
		for (let i = 0; i < 300 && !existsSync(capturePath); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (!existsSync(capturePath)) {
			throw new Error(`request hook did not fire\nstdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`);
		}
		return JSON.parse(readFileSync(capturePath, "utf8"));
	} finally {
		if (child && child.exitCode === null) child.kill("SIGTERM");
		if (childClosed) await childClosed;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function assertRewritten(capture, provider) {
	assert.equal(capture.provider, provider);
	const parts = capture.payload?.request?.systemInstruction?.parts ?? [];
	const text = parts.map((part) => part?.text ?? "").join("\n");
	const ZWSP = "\u200B";
	assert.ok(text.includes(ZWSP), "zero-width space inserted into fingerprint");
	assert.doesNotMatch(text, /RFC 2119/, "contiguous RFC 2119 fingerprint broken");
	assert.doesNotMatch(text, /<conventions>/, "contiguous <conventions> tag broken");
	const stripped = text.split(ZWSP).join("");
	assert.match(stripped, /(?:<conventions>\s*)?RFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL\./,
		"content preserved once zero-width spaces are stripped");
	assert.equal(capture.wire.body.requestType, "agent");
	assert.match(capture.wire.url, /\/v1internal:streamGenerateContent\?alt=sse$/);
	assert.match(String(capture.wire.headers?.["User-Agent"] ?? capture.wire.headers?.["user-agent"]), /^antigravity\//);
	assert.deepEqual(capture.wire.body, capture.payload);
}

const base = await runCapture("google-antigravity/gemini-3.8-flash", []);
assertRewritten(base, "google-antigravity");

const synthetic = await runCapture("google-antigravity-2/gemini-3.8-flash", [
	{ provider: "google-antigravity", index: 2 },
]);
assertRewritten(synthetic, "google-antigravity-2");

console.log("base and synthetic Antigravity payload hooks passed");
