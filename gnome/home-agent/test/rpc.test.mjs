// The home role end to end: the real pi in RPC mode, started by the launcher
// with the extension, against a model, a daemon and a Home Assistant that this
// test plays.
//
//   the model           an OpenAI-compatible server here; each test scripts its
//                       answers and reads what pi sent it (the system prompt, the
//                       tools offered)
//   the daemon          a `busctl` that logs its arguments and answers
//                       AgentContext and AgentTool
//   Home Assistant      a streamable-HTTP MCP server here, as /api/mcp: two
//                       tools and a resource, and a log of the calls with the
//                       Authorization header they came with
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
const HOUSE = ["mcp__homeassistant__HassTurnOn", "mcp__homeassistant__GetLiveContext"];
const TOKEN = "the-assistants-long-lived-token";

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

// ---- Home Assistant's MCP server ----
const houseCalls = []; // {name, arguments, authorization}
const hass = http.createServer((req, res) => {
	if (req.method !== "POST" || req.url !== "/api/mcp") {
		res.writeHead(405);
		return res.end();
	}
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const msg = JSON.parse(raw);
		if (req.headers.authorization !== `Bearer ${TOKEN}`) {
			res.writeHead(401);
			return res.end();
		}
		if (msg.id === undefined) {
			res.writeHead(202);
			return res.end();
		}
		const reply = (result) => {
			res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s1" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
		};
		const object = (properties) => ({ type: "object", properties });
		switch (msg.method) {
			case "initialize":
				return reply({
					protocolVersion: msg.params.protocolVersion,
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: "home-assistant", version: "2026.5.4" },
				});
			case "tools/list":
				return reply({
					tools: [
						{ name: "HassTurnOn", description: "Turns on a device or entity", inputSchema: object({ name: { type: "string" }, area: { type: "string" } }) },
						{ name: "GetLiveContext", description: "The current state of the exposed devices", inputSchema: object({}) },
					],
				});
			case "tools/call":
				houseCalls.push({ ...msg.params, authorization: req.headers.authorization });
				return reply({ content: [{ type: "text", text: '{"success":true,"turned_on":"Living room lamp"}' }] });
			case "resources/list":
				return reply({ resources: [{ uri: "hass://entities", name: "entities" }] });
			case "resources/templates/list":
				return reply({ resourceTemplates: [] });
			default:
				return reply({});
		}
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

/** One pi started by the launcher, as the daemon starts it, and the RPC to it. */
class Agent {
	constructor(name, extra) {
		this.events = [];
		this.waiters = [];
		this.buffer = "";
		this.stderr = "";
		this.state = join(dir, name);
		mkdirSync(this.state);
		this.proc = spawn(launcher, [], { env: { ...env, STATE_DIRECTORY: this.state, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stderr.on("data", (c) => {
			this.stderr += c;
			process.stderr.write(c);
		});
		this.proc.stdout.on("data", (c) => {
			this.buffer += c;
			let i;
			while ((i = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, i);
				this.buffer = this.buffer.slice(i + 1);
				if (!line.trim()) continue;
				const ev = JSON.parse(line);
				this.events.push(ev);
				this.waiters = this.waiters.filter((w) => !w(ev));
			}
		});
	}

	send(msg) {
		this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	until(match) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("pi did not answer in time")), 60_000);
			this.waiters.push((ev) => (match(ev) ? (clearTimeout(timer), resolve(ev), true) : false));
		});
	}

	async command(msg) {
		const id = `c${this.events.length}-${Math.random()}`;
		const answered = this.until((ev) => ev.type === "response" && ev.id === id);
		this.send({ ...msg, id });
		return answered;
	}

	/** One question: the last assistant message's text, and the tool results on the way. */
	async ask(text) {
		const from = this.events.length;
		requests = [];
		const settled = this.until((ev) => ev.type === "agent_settled");
		this.send({ type: "prompt", message: text });
		await settled;
		const ended = this.events.slice(from).filter((ev) => ev.type === "message_end").map((ev) => ev.message);
		const last = ended.filter((m) => m.role === "assistant").pop();
		return {
			text: (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""),
			results: ended.filter((m) => m.role === "toolResult"),
		};
	}

	stop() {
		this.proc.stdin.end();
		this.proc.kill();
	}
}

const agents = [];
const agent = (name, extra = {}) => {
	const a = new Agent(name, extra);
	agents.push(a);
	return a;
};
let jarvis; // as on a machine without a Home Assistant token

before(async () => {
	if (skip) return;
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	await new Promise((r) => hass.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	writeFileSync(join(dir, "models.json"), JSON.stringify({
		providers: { balaur: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: "balaur" }, { id: "balaur-local" }] } },
	}));
	writeFileSync(join(dir, "config.json"), JSON.stringify({
		location: { name: "Bucharest", latitude: 44.43, longitude: 26.1 }, newsFeeds: [], search: { model: "search-model" },
	}));
	writeFileSync(join(dir, "context.json"), JSON.stringify({ type: "s", data: [JSON.stringify(context)] }));
	writeFileSync(join(dir, "tool.json"), JSON.stringify({ type: "s", data: [JSON.stringify({ id: "t1", seconds: 120 })] }));
	writeFileSync(join(dir, "token"), `${TOKEN}\n`);
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
	mkdirSync(join(dir, "run"));
	env = {
		PATH: process.env.PATH, HOME: dir, XDG_RUNTIME_DIR: join(dir, "run"),
		BALAUR_PI_MODELS: join(dir, "models.json"), BALAUR_ASSISTANT_CONFIG: join(dir, "config.json"),
		BALAUR_BUSCTL: busctl, MISTRAL_API_KEY: "none",
	};
	jarvis = agent("state", { BALAUR_LLM_MODEL: "a-model-the-entryway-does-not-have" });
});

after(() => {
	for (const a of agents) a.stop();
	server.close();
	hass.close();
});

test("it starts with a model of the entryway, and lists them", { skip }, async () => {
	const state = await jarvis.command({ type: "get_state" });
	assert.equal(state.data.model.provider, "balaur");
	assert.equal(state.data.model.id, "balaur", "an unknown model falls back to the first");
	const models = await jarvis.command({ type: "get_available_models" });
	assert.deepEqual(models.data.models.filter((m) => m.provider === "balaur").map((m) => m.id), ["balaur", "balaur-local"]);
});

test("the model gets our prompt and our tools, and a daemon tool reaches the daemon", { skip }, async () => {
	script = (body) => (afterTool(body) ? { text: "Gata." } : { tool: { name: "set_timer", args: { duration_seconds: 120, label: "ceai" } } });
	const r = await jarvis.ask("pune un timer de 2 minute pentru ceai");
	assert.equal(r.text, "Gata.");
	assert.deepEqual(toolNames(requests[0]).sort(), [...OURS].sort(), "exactly our tools are offered");
	const system = systemText(requests[0]);
	assert.match(system, /^You are Jarvis, the private voice assistant of a home in Bucharest\./);
	assert.match(system, /Today is Tuesday, 10 November 2026\. The local time is 09:15/);
	assert.match(system, /The user is speaking Romanian now/);
	assert.match(system, /\[m1\] Ana is allergic to nuts\./);
	assert.doesNotMatch(system, /coding assistant|pi documentation/i, "nothing of pi's own prompt");
	assert.doesNotMatch(system, /Home Assistant/, "no house devices without the server");
	const bus = readFileSync(busLog, "utf8");
	assert.match(bus, /org\.balaur\.Assistant1 AgentContext\n/);
	assert.match(bus, /AgentTool ss set_timer \{"duration_seconds":120,"label":"ceai"\}\n/);
	assert.equal(r.results[0].content[0].text, '{"id":"t1","seconds":120}', "the daemon's result goes to the model as it is");
	assert.equal(existsSync(join(jarvis.state, "pi", "mcp.json")), false, "no MCP configuration without Home Assistant");
});

test("after 5 rounds of tools the model gets none and has to answer", { skip }, async () => {
	script = (body) => (toolNames(body).length > 0 ? { tool: { name: "list_timers" } } : { text: "Atât." });
	const r = await jarvis.ask("tot întrebi");
	assert.equal(r.text, "Atât.");
	assert.equal(requests.length, 6);
	assert.equal(toolNames(requests[5]).length, 0, "the sixth round has no tools");
	script = () => ({ text: "ok" });
	await jarvis.ask("și acum");
	assert.equal(toolNames(requests[0]).length, OURS.length, "the next question has them again");
});

test("a tool that is not ours never runs", { skip }, async () => {
	const marker = join(dir, "ran");
	script = (body) => (afterTool(body) ? { text: "nu pot" } : { tool: { name: "bash", args: { command: `touch ${marker}` } } });
	const r = await jarvis.ask("rulează ceva");
	assert.equal(existsSync(marker), false, "the command did not run");
	assert.equal(r.results.length, 1);
	assert.equal(r.results[0].isError, true, "the model is told it failed");
	assert.equal(r.text, "nu pot");
});

const hassEnv = (token) => ({
	BALAUR_LLM_MODEL: "balaur",
	BALAUR_HOME_ASSISTANT_URL: `http://127.0.0.1:${hass.address().port}/api/mcp`,
	BALAUR_HOME_ASSISTANT_TOKEN_FILE: join(dir, token),
});

test("with Home Assistant: its tools beside ours and nothing else, called with the token", { skip }, async () => {
	const house = agent("state-hass", hassEnv("token"));
	script = (body) =>
		afterTool(body) ? { text: "Am aprins lampa." } : { tool: { name: HOUSE[0], args: { name: "lampa", area: "sufragerie" } } };
	const r = await house.ask("aprinde lampa din sufragerie");
	assert.equal(r.text, "Am aprins lampa.");
	assert.deepEqual(toolNames(requests[0]).sort(), [...OURS, ...HOUSE].sort(), "ours and the house's: no codemode, tool_search or resource tools");
	assert.match(systemText(requests[0]), /Home Assistant tools/);
	assert.equal(houseCalls.length, 1, "the call reached Home Assistant");
	assert.equal(houseCalls[0].name, "HassTurnOn");
	assert.deepEqual(houseCalls[0].arguments, { name: "lampa", area: "sufragerie" });
	assert.equal(houseCalls[0].authorization, `Bearer ${TOKEN}`);
	assert.match(r.results[0].content[0].text, /Living room lamp/);
	const config = readFileSync(join(house.state, "pi", "mcp.json"), "utf8");
	assert.doesNotMatch(config, new RegExp(TOKEN), "the token is not written into pi's configuration");

	script = (body) => (toolNames(body).length > 0 ? { tool: { name: HOUSE[1] } } : { text: "Atât." });
	const capped = await house.ask("tot întrebi");
	assert.equal(capped.text, "Atât.");
	assert.equal(requests.length, 6);
	assert.equal(toolNames(requests[5]).length, 0, "the sixth round has no tools, the house's neither");
	script = () => ({ text: "ok" });
	await house.ask("și acum");
	assert.deepEqual(toolNames(requests[0]).sort(), [...OURS, ...HOUSE].sort(), "the next question has them all again");
});

test("with Home Assistant down, it still starts and answers", { skip }, async () => {
	const closed = http.createServer();
	await new Promise((r) => closed.listen(0, "127.0.0.1", r));
	const port = closed.address().port;
	await new Promise((r) => closed.close(r));
	const down = agent("state-down", { ...hassEnv("token"), BALAUR_HOME_ASSISTANT_URL: `http://127.0.0.1:${port}/api/mcp` });
	script = () => ({ text: "Bună." });
	const r = await down.ask("salut");
	assert.equal(r.text, "Bună.");
	assert.deepEqual(toolNames(requests[0]).sort(), [...OURS].sort(), "our tools only");
	assert.match(systemText(requests[0]), /the house cannot be reached/, "the model knows to say so");
});

test("with the token unreadable, it starts as without Home Assistant", { skip }, async () => {
	const none = agent("state-notoken", hassEnv("no-such-token"));
	script = () => ({ text: "Bună." });
	const r = await none.ask("salut");
	assert.equal(r.text, "Bună.");
	assert.deepEqual(toolNames(requests[0]).sort(), [...OURS].sort());
	assert.match(none.stderr, /no readable Home Assistant token/);
});

/** Runs the launcher's one-shot test; the model server is in this process, so not spawnSync. */
function selfTest() {
	return new Promise((resolve) => {
		const p = spawn(launcher, ["--test"], { env: { ...env, STATE_DIRECTORY: join(dir, "state"), BALAUR_LLM_MODEL: "balaur" }, stdio: ["ignore", "ignore", "pipe"] });
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
