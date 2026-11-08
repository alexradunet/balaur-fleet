#!/usr/bin/env node
// balaur-agent: the brain of the Balaur voice assistant, a pi SDK session started
// by the GJS daemon (gnome/assistant/agent.js), speaking JSON lines on
// stdin/stdout (see protocol.ts). The daemon restarts it when the model
// settings change.
//
// Environment (set by the daemon):
//   BALAUR_ASSISTANT_CONFIG  the assistant's config JSON (location, newsFeeds, search.model; llm.* as fallback)
//   BALAUR_LLM_PROVIDER, BALAUR_LLM_MODEL, BALAUR_LLM_BASE_URL, BALAUR_LLM_KEY   the chat model (GSettings + keyring)
//   MISTRAL_API_KEY, BALAUR_SPEECH_BASE_URL   Mistral, for the web_search tool
//   BALAUR_AGENT_DIR         an empty private directory (pi's nominal cwd/agentDir)

import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BalaurAgent } from "./agent.ts";
import { catalog, createRuntime, selectModel, testModel } from "./models.ts";
import { lines, Server, writer } from "./protocol.ts";
import { buildTools } from "./tools.ts";

function loadConfig(): any {
	const path = process.env.BALAUR_ASSISTANT_CONFIG;
	return path ? JSON.parse(readFileSync(path, "utf8")) : {};
}

async function main() {
	// Nothing may write to stdout but the protocol.
	console.log = console.error;
	console.info = console.error;
	const env = process.env;
	const cfg = loadConfig();
	const dir = env.BALAUR_AGENT_DIR || join(tmpdir(), `balaur-agent-${process.getuid?.() ?? 0}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const mistralKey = env.MISTRAL_API_KEY ?? "";
	const provider = env.BALAUR_LLM_PROVIDER || "mistral";
	const settings = {
		provider,
		model: env.BALAUR_LLM_MODEL || cfg.llm?.model || "",
		baseUrl: env.BALAUR_LLM_BASE_URL ?? "",
		key: env.BALAUR_LLM_KEY || (provider === "mistral" ? mistralKey : ""),
	};

	const send = writer(process.stdout);
	const rt = await createRuntime();
	const models = catalog(rt); // before our settings add anything
	let model;
	try {
		model = await selectModel(rt, settings);
	} catch (e) {
		// Stay up without a model: the app still needs the catalog to fix the settings.
		const message = (e as Error).message;
		console.error(`balaur-agent: ${message}`);
		send({ type: "ready", tools: [], models, error: message });
		for await (const line of lines(process.stdin)) {
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.type === "prompt") send({ type: "error", id: msg.id, message });
			if (msg.type === "test") send({ type: "test_result", id: msg.id, error: message });
		}
		process.exit(0);
	}

	let server: Server | null = null;
	const tools = buildTools(
		{
			location: cfg.location ?? { name: "", latitude: 0, longitude: 0 },
			newsFeeds: cfg.newsFeeds ?? [],
			searchModel: cfg.search?.model ?? "",
			mistralBaseURL: env.BALAUR_SPEECH_BASE_URL || "https://api.mistral.ai/v1",
			mistralKey,
		},
		(name, args, signal) => server!.forward(name, args, signal),
	);
	const agent = new BalaurAgent({ modelRuntime: rt, model, tools, cwd: dir });
	await agent.start(); // throws (exit 1) if any tool but ours is present
	server = new Server(agent, send, () => testModel(rt, model));
	console.error(`balaur-agent: ready (model ${settings.provider}/${settings.model}; tools ${agent.activeToolNames.join(", ")})`);
	send({ type: "ready", tools: agent.activeToolNames, models });

	for await (const line of lines(process.stdin)) server.handle(line);
	// The daemon closed our stdin: it is going away.
	agent.dispose();
	process.exit(0);
}

main().catch((e) => {
	console.error(`balaur-agent: ${e?.stack ?? e}`);
	process.exit(1);
});
