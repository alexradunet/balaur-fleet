// The home role end to end: the real pi in RPC mode, started by the launcher
// with the extension, against a model and a daemon that this test plays.
//
//   the model   an OpenAI-compatible server here; each test scripts its answers
//               and reads what pi sent it (the system prompt, the tools offered)
//   the daemon  a `busctl` that logs its arguments and answers AgentContext and
//               AgentTool
//
// Run by the package (pkgs/balaur-home-agent.nix) with BALAUR_HOME_AGENT set to
// the installed launcher; skipped without it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const launcher = process.env.BALAUR_HOME_AGENT;
const skip = launcher ? false : "BALAUR_HOME_AGENT is not set";

const OURS = [
	"set_timer", "list_timers", "cancel_timer", "add_reminder", "list_reminders", "delete_reminder",
	"remember", "forget", "house_list_add", "house_list_remove", "house_list_show", "set_volume",
	"weather", "news", "web_search",
];

const dir = mkdtempSync(join(tmpdir(), "home-agent-"));
const busLog = join(dir, "busctl.log");
const context = {
	name: "Jarvis", location: "Bucharest", date: "Tuesday, 10 November 2026", time: "09:15",
	zone: "Europe/Bucharest", typed: false, lang: "ro", memories: [{ id: "m1", fact: "Ana is allergic to nuts." }],
};

// ---- the model ----
let script = () => ({ text: "ok" }); // (request body) -> {text} | {tool: {name, args}} | {status}
let requests = [];
const server = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const body = raw ? JSON.parse(raw) : {};
		requests.push(body);
		const step = script(body);
		if (step.status) {
			res.writeHead(step.status, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ error: { message: "no such model here" } }));
		}
		const chunk = (delta, finish = null) =>
			`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		if (step.tool) {
			res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call${requests.length}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args ?? {}) } }] }));
			res.write(chunk({}, "tool_calls"));
		} else {
			res.write(chunk({ role: "assistant", content: step.text }));
			res.write(chunk({}, "stop"));
		}
		res.end("data: [DONE]\n\n");
	});
});

/** Whether pi is sending a tool's result: the model's turn to speak. */
const afterTool = (body) => body.messages.at(-1)?.role === "tool";
const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name);
const systemText = (body) => {
	const m = body.messages.find((x) => x.role === "system" || x.role === "developer");
	return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text).join("");
};

// ---- pi ----
let env;
let pi;
let events = [];
let waiters = [];
let buffer = "";

function start(model) {
	pi = spawn(launcher, [], { env: { ...env, BALAUR_LLM_MODEL: model }, stdio: ["pipe", "pipe", "inherit"] });
	pi.stdout.on("data", (c) => {
		buffer += c;
		let i;
		while ((i = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (!line.trim()) continue;
			const ev = JSON.parse(line);
			events.push(ev);
			waiters = waiters.filter((w) => !w(ev));
		}
	});
}

const send = (msg) => pi.stdin.write(`${JSON.stringify(msg)}\n`);
const until = (match) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("pi did not answer in time")), 60_000);
		waiters.push((ev) => (match(ev) ? (clearTimeout(timer), resolve(ev), true) : false));
	});

async function command(msg) {
	const id = `c${events.length}-${Math.random()}`;
	const answered = until((ev) => ev.type === "response" && ev.id === id);
	send({ ...msg, id });
	return answered;
}

/** One question: the last assistant message's text, and the tool results on the way. */
async function ask(text) {
	const from = events.length;
	requests = [];
	const settled = until((ev) => ev.type === "agent_settled");
	send({ type: "prompt", message: text });
	await settled;
	const ended = events.slice(from).filter((ev) => ev.type === "message_end").map((ev) => ev.message);
	const last = ended.filter((m) => m.role === "assistant").pop();
	return {
		text: (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""),
		results: ended.filter((m) => m.role === "toolResult"),
	};
}

before(async () => {
	if (skip) return;
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	writeFileSync(join(dir, "models.json"), JSON.stringify({
		providers: { balaur: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: "balaur" }, { id: "balaur-local" }] } },
	}));
	writeFileSync(join(dir, "config.json"), JSON.stringify({
		location: { name: "Bucharest", latitude: 44.43, longitude: 26.1 }, newsFeeds: [], search: { model: "search-model" },
	}));
	writeFileSync(join(dir, "context.json"), JSON.stringify({ type: "s", data: [JSON.stringify(context)] }));
	writeFileSync(join(dir, "tool.json"), JSON.stringify({ type: "s", data: [JSON.stringify({ id: "t1", seconds: 120 })] }));
	const busctl = join(dir, "busctl");
	writeFileSync(busctl, `#!/bin/sh
echo "$*" >> ${busLog}
case "$*" in
  *" AgentContext") cat ${dir}/context.json ;;
  *" AgentTool ss "*) cat ${dir}/tool.json ;;
  *) echo "Call failed: unknown method" >&2; exit 1 ;;
esac
`);
	chmodSync(busctl, 0o755);
	for (const d of ["state", "run"]) mkdirSync(join(dir, d));
	env = {
		PATH: process.env.PATH, HOME: dir, STATE_DIRECTORY: join(dir, "state"), XDG_RUNTIME_DIR: join(dir, "run"),
		BALAUR_PI_MODELS: join(dir, "models.json"), BALAUR_ASSISTANT_CONFIG: join(dir, "config.json"),
		BALAUR_BUSCTL: busctl, MISTRAL_API_KEY: "none",
	};
	start("a-model-the-entryway-does-not-have");
});

after(() => {
	pi?.stdin.end();
	pi?.kill();
	server.close();
});

test("it starts with a model of the entryway, and lists them", { skip }, async () => {
	const state = await command({ type: "get_state" });
	assert.equal(state.data.model.provider, "balaur");
	assert.equal(state.data.model.id, "balaur", "an unknown model falls back to the first");
	const models = await command({ type: "get_available_models" });
	assert.deepEqual(models.data.models.filter((m) => m.provider === "balaur").map((m) => m.id), ["balaur", "balaur-local"]);
});

test("the model gets our prompt and our tools, and a daemon tool reaches the daemon", { skip }, async () => {
	script = (body) => (afterTool(body) ? { text: "Gata." } : { tool: { name: "set_timer", args: { duration_seconds: 120, label: "ceai" } } });
	const r = await ask("pune un timer de 2 minute pentru ceai");
	assert.equal(r.text, "Gata.");
	assert.deepEqual(toolNames(requests[0]).sort(), [...OURS].sort(), "exactly our tools are offered");
	const system = systemText(requests[0]);
	assert.match(system, /^You are Jarvis, the private voice assistant of a home in Bucharest\./);
	assert.match(system, /Today is Tuesday, 10 November 2026\. The local time is 09:15/);
	assert.match(system, /The user is speaking Romanian now/);
	assert.match(system, /\[m1\] Ana is allergic to nuts\./);
	assert.doesNotMatch(system, /coding assistant|pi documentation/i, "nothing of pi's own prompt");
	const bus = readFileSync(busLog, "utf8");
	assert.match(bus, /org\.balaur\.Assistant1 AgentContext\n/);
	assert.match(bus, /AgentTool ss set_timer \{"duration_seconds":120,"label":"ceai"\}\n/);
	assert.equal(r.results[0].content[0].text, '{"id":"t1","seconds":120}', "the daemon's result goes to the model as it is");
});

test("after 5 rounds of tools the model gets none and has to answer", { skip }, async () => {
	script = (body) => (toolNames(body).length > 0 ? { tool: { name: "list_timers" } } : { text: "Atât." });
	const r = await ask("tot întrebi");
	assert.equal(r.text, "Atât.");
	assert.equal(requests.length, 6);
	assert.equal(toolNames(requests[5]).length, 0, "the sixth round has no tools");
	script = () => ({ text: "ok" });
	await ask("și acum");
	assert.equal(toolNames(requests[0]).length, OURS.length, "the next question has them again");
});

test("a tool that is not ours never runs", { skip }, async () => {
	const marker = join(dir, "ran");
	script = (body) => (afterTool(body) ? { text: "nu pot" } : { tool: { name: "bash", args: { command: `touch ${marker}` } } });
	const r = await ask("rulează ceva");
	assert.equal(existsSync(marker), false, "the command did not run");
	assert.equal(r.results.length, 1);
	assert.equal(r.results[0].isError, true, "the model is told it failed");
	assert.equal(r.text, "nu pot");
});

/** Runs the launcher's one-shot test; the model server is in this process, so not spawnSync. */
function selfTest() {
	return new Promise((resolve) => {
		const p = spawn(launcher, ["--test"], { env: { ...env, BALAUR_LLM_MODEL: "balaur" }, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		p.stderr.on("data", (c) => (stderr += c));
		p.on("close", (status) => resolve({ status, stderr }));
	});
}

test("--test tells whether the model answers", { skip }, async () => {
	script = () => ({ text: "OK" });
	assert.equal((await selfTest()).status, 0);
	script = () => ({ status: 401 });
	const bad = await selfTest();
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /no such model here|401/);
});
