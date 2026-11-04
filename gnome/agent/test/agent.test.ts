// The agent with a stubbed model (pi-ai's faux provider): tool isolation, the
// per-turn system prompt, the tool-call round trip over the protocol, abort,
// reset and the cap on tool rounds. Run: npm test (node --test test/).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOLS, DuetAgent, MAX_TOOL_ROUNDS } from "../src/agent.ts";
import { systemPrompt } from "../src/prompt.ts";
import { Server } from "../src/protocol.ts";
import { buildTools, DAEMON_TOOLS } from "../src/tools.ts";

const context = {
	name: "Jarvis",
	location: "Bucharest",
	date: "Wednesday, 4 November 2026",
	time: "16:13",
	zone: "Europe/Bucharest",
	memories: [{ id: "ab12cd34", fact: "Ana is allergic to nuts." }],
};

// The tools declared to the model: replayed from the transcript's system messages.
function declaredTools(ctx: any): number {
	const s = new Set<string>();
	for (const m of ctx.messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) s.add(t.name);
		for (const t of m.toolsRemoved ?? []) s.delete(typeof t === "string" ? t : t.name);
	}
	return s.size;
}

async function setup(opts: { tokensPerSecond?: number } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], ...opts });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const sent: any[] = [];
	let server: Server;
	const tools = buildTools(
		{
			location: { name: "Bucharest", latitude: 44.43, longitude: 26.1 },
			newsFeeds: [],
			searchModel: "mistral-medium-latest",
			mistralBaseURL: "http://127.0.0.1:9/v1",
			mistralKey: "k",
		},
		(name, args, signal) => server.forward(name, args, signal),
	);
	const agent = new DuetAgent({
		modelRuntime,
		model: faux.getModel(),
		tools,
		cwd: mkdtempSync(join(tmpdir(), "duet-agent-test-")),
	});
	await agent.start();
	const waiters: Array<(m: any) => boolean> = [];
	server = new Server(agent, (m) => {
		sent.push(m);
		for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](m)) waiters.splice(i, 1);
	});
	const next = (type: string) =>
		new Promise<any>((resolve) => {
			const old = sent.find((m) => m.type === type && !m._seen);
			if (old) {
				old._seen = true;
				return resolve(old);
			}
			waiters.push((m) => {
				if (m.type !== type) return false;
				m._seen = true;
				resolve(m);
				return true;
			});
		});
	return { faux, agent, server, sent, next };
}

test("only our tools exist: no pi built-in is active, registered or callable", async () => {
	const { agent } = await setup();
	const active = agent.activeToolNames;
	assert.deepEqual(new Set(active), new Set([...DAEMON_TOOLS, "weather", "news", "web_search"]));
	for (const b of BUILTIN_TOOLS) assert.ok(!active.includes(b), `${b} is active`);
	agent.checkTools(); // throws on anything foreign
	agent.dispose();
});

test("a prompt with a daemon-side tool call round-trips through the protocol", async () => {
	const { faux, agent, server, next } = await setup();
	let seenPrompt = "";
	let toolResultSeen = "";
	faux.setResponses([
		(ctx: any) => {
			seenPrompt = JSON.stringify(ctx.systemPrompt ?? ctx.messages?.[0] ?? "");
			return fauxAssistantMessage(fauxToolCall("house_list_add", { list: "shopping", items: ["lapte"] }, { id: "t1" }), {
				stopReason: "toolUse",
			});
		},
		(ctx: any) => {
			const last = ctx.messages[ctx.messages.length - 1];
			toolResultSeen = JSON.stringify(last.content);
			return fauxAssistantMessage(fauxText("Am pus lapte pe listă."));
		},
	]);
	server.handle(JSON.stringify({ type: "prompt", id: "p1", text: "pune lapte pe listă", lang: "ro", context }));
	const call = await next("tool_call");
	assert.equal(call.prompt, "p1");
	assert.equal(call.name, "house_list_add");
	assert.deepEqual(call.args, { list: "shopping", items: ["lapte"] });
	server.handle(
		JSON.stringify({ type: "tool_result", id: call.id, ok: true, result: '{"added":["lapte"],"list":"shopping","open_items":1}' }),
	);
	const reply = await next("reply");
	assert.deepEqual({ ...reply, _seen: undefined }, { type: "reply", id: "p1", text: "Am pus lapte pe listă.", lang: "ro", _seen: undefined });
	assert.match(toolResultSeen, /open_items/);
	// The per-turn system prompt reached the model, as assistant.go wrote it.
	assert.match(seenPrompt, /You are Jarvis, the private voice assistant of a home in Bucharest/);
	assert.match(agent.systemPrompt, /The user is speaking Romanian now/);
	assert.match(agent.systemPrompt, /\[ab12cd34\] Ana is allergic to nuts\./);
	agent.dispose();
});

test("a failing daemon tool reaches the model as an error, and the turn still answers", async () => {
	const { faux, agent, server, next } = await setup();
	let result: any;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("forget", { id: "nope" }), { stopReason: "toolUse" }),
		(ctx: any) => {
			result = ctx.messages[ctx.messages.length - 1];
			return fauxAssistantMessage(fauxText("Nu am găsit."));
		},
	]);
	server.handle(JSON.stringify({ type: "prompt", id: "p2", text: "uită asta", lang: "ro", context }));
	const call = await next("tool_call");
	server.handle(JSON.stringify({ type: "tool_result", id: call.id, ok: false, error: "no such memory" }));
	const reply = await next("reply");
	assert.equal(reply.text, "Nu am găsit.");
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /no such memory/);
	agent.dispose();
});

test("the system prompt follows each turn's context", async () => {
	const { faux, agent, server, next } = await setup();
	faux.setResponses([fauxAssistantMessage(fauxText("One.")), fauxAssistantMessage(fauxText("Two."))]);
	server.handle(JSON.stringify({ type: "prompt", id: "a", text: "hi", lang: "en", context }));
	await next("reply");
	assert.match(agent.systemPrompt, /speaking English now/);
	server.handle(
		JSON.stringify({ type: "prompt", id: "b", text: "salut", lang: "ro", context: { ...context, time: "16:14", typed: true } }),
	);
	await next("reply");
	assert.match(agent.systemPrompt, /The local time is 16:14/);
	assert.match(agent.systemPrompt, /typed in the Duet app/);
	assert.doesNotMatch(agent.systemPrompt, /speaking English now/);
	agent.dispose();
});

test("abort stops a slow answer; reset forgets the conversation", async () => {
	const { faux, agent, server, next } = await setup({ tokensPerSecond: 5 });
	faux.setResponses([fauxAssistantMessage(fauxText("This is a very long and slow answer that takes a while. ".repeat(20)))]);
	server.handle(JSON.stringify({ type: "prompt", id: "slow", text: "talk", lang: "en", context }));
	await new Promise((r) => setTimeout(r, 300));
	server.handle(JSON.stringify({ type: "abort", id: "slow" }));
	const err = await next("error");
	assert.equal(err.id, "slow");
	assert.equal(err.aborted, true);
	assert.ok(agent.messageCount > 0);
	server.handle(JSON.stringify({ type: "reset" }));
	faux.setResponses([fauxAssistantMessage(fauxText("Fresh."))]);
	server.handle(JSON.stringify({ type: "prompt", id: "after", text: "hi", lang: "en", context }));
	const reply = await next("reply");
	assert.equal(reply.text, "Fresh.");
	agent.dispose();
});

test(`the last of ${MAX_TOOL_ROUNDS} rounds gets no tools, so the model must answer`, async () => {
	const { faux, agent, server, next } = await setup();
	const toolCounts: number[] = [];
	const loop = (ctx: any) => {
		toolCounts.push(declaredTools(ctx));
		return toolCounts.length < MAX_TOOL_ROUNDS
			? fauxAssistantMessage(fauxToolCall("weather", { place: "" }), { stopReason: "toolUse" })
			: fauxAssistantMessage(fauxText("Gave up on tools."));
	};
	faux.setResponses(Array.from({ length: MAX_TOOL_ROUNDS }, () => loop));
	server.handle(JSON.stringify({ type: "prompt", id: "loop", text: "weather?", lang: "en", context }));
	const reply = await next("reply");
	assert.equal(reply.text, "Gave up on tools.");
	assert.equal(toolCounts.length, MAX_TOOL_ROUNDS);
	assert.ok(toolCounts[0] > 0);
	assert.equal(toolCounts[MAX_TOOL_ROUNDS - 1], 0);
	// The next question has its tools back.
	agent.checkTools();
	agent.dispose();
});

test("systemPrompt matches assistant.go for English, typed, no memories", () => {
	const p = systemPrompt({ name: "Jarvis", date: "Monday, 2 January 2006", time: "15:04", zone: "Local", typed: true }, "en");
	assert.ok(p.startsWith("You are Jarvis, the private voice assistant of a home. You run on a small home server"));
	assert.ok(p.includes("Today is Monday, 2 January 2006. The local time is 15:04 (24-hour clock, Local).\n\nRules:\n"));
	assert.ok(p.endsWith("- This message was typed in the Duet app, not spoken; the reply is shown as text and may be a little longer, still plain text.\n"));
});
