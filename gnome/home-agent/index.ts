// The home role of pi: the brain of the Balaur voice assistant.
//
// The GJS daemon (gnome/assistant/) runs the installed pi in RPC mode with this
// extension and nothing else: no built-in tools, no skills, no context files.
// The extension gives the model the household's tools and its system prompt.
//
//   daemon-side tools  timers, reminders, the house lists, memory, the speaker.
//                      Their state lives in the daemon, so a call goes to it over
//                      D-Bus (AgentTool) and its result comes back as JSON.
//   tools here         weather, news and web search (web.ts).
//   the system prompt  built for every question from the daemon's context
//                      (AgentContext): the date and time, the language, what the
//                      household asked it to remember (prompt.ts).
//
// A voice assistant that reads web pages and news must never be able to run a
// command or touch a file. Three locks: the launcher starts pi without its own
// tools; this extension exits when the model is offered any tool but ours; and a call to any
// other tool is blocked. The one exception is Home Assistant's MCP server, when the
// launcher configured it: its tools (mcp__homeassistant__*) switch the house's
// devices as the assistant's own non-admin Home Assistant user.
//
// Environment (set by the launcher and the daemon):
//   BALAUR_ASSISTANT_CONFIG   the assistant's config JSON (location, newsFeeds, search.model)
//   MISTRAL_API_KEY, BALAUR_SPEECH_BASE_URL   Mistral, for web_search
//   BALAUR_BUSCTL             the busctl to call the daemon with (default: busctl)
//   BALAUR_HOUSE_DEVICES      set when the launcher configured Home Assistant's MCP server

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { systemPrompt, type TurnContext } from "./prompt.ts";
import { News, weather, webSearch } from "./web.ts";

// A cap on model rounds per question; the last one gets no tools, so it answers.
export const MAX_TOOL_ROUNDS = 6;
// Each tool gets 20 seconds.
const TOOL_TIMEOUT_MS = 20_000;

const BUS = ["org.balaur.Assistant", "/org/balaur/Assistant", "org.balaur.Assistant1"];
// Home Assistant's MCP server (the launcher's mcp.json): its tools are the only
// ones not ours that may be offered or run.
const HOUSE = "mcp__homeassistant__";

const str = (description: string) => Type.String({ description });
const opt = <T>(t: T) => Type.Optional(t as any);
const integer = (description: string) => Type.Integer({ description });
const strList = (description: string) => Type.Array(Type.String(), { description });
const strEnum = (values: string[]) => Type.Unsafe<string>({ type: "string", enum: values });

interface Spec {
	name: string;
	description: string;
	parameters: any;
}

/** The daemon-side tools: names, descriptions and parameters the model has always had. */
export const daemonToolSpecs: Spec[] = [
	{
		name: "set_timer",
		description: "Start a countdown timer. It rings and speaks the label when it ends.",
		parameters: Type.Object({
			duration_seconds: integer("Length of the timer in seconds"),
			label: opt(str("Short name for the timer in the user's language, e.g. 'paste' or 'pasta'")),
		}),
	},
	{
		name: "list_timers",
		description: "List running timers with the seconds remaining.",
		parameters: Type.Object({}),
	},
	{
		name: "cancel_timer",
		description: "Cancel a timer by id or label, or all timers.",
		parameters: Type.Object({
			id: opt(str("Timer id")),
			label: opt(str("Timer label")),
			all: opt(Type.Boolean({ description: "Cancel every timer" })),
		}),
	},
	{
		name: "add_reminder",
		description: "Set a reminder that is spoken aloud at a given local date and time, optionally repeating.",
		parameters: Type.Object({
			text: str("What to remind about, phrased to be spoken, in the user's language"),
			at: str("Local date and time, format 'YYYY-MM-DD HH:MM'"),
			repeat: opt(strEnum(["none", "daily", "weekly"])),
		}),
	},
	{
		name: "list_reminders",
		description: "List upcoming reminders.",
		parameters: Type.Object({}),
	},
	{
		name: "delete_reminder",
		description: "Delete a reminder by id (get ids from list_reminders).",
		parameters: Type.Object({ id: str("Reminder id") }),
	},
	{
		name: "remember",
		description:
			"Save a lasting fact or preference about the user or household (names, birthdays, diet, routines, preferences) so you know it in future conversations.",
		parameters: Type.Object({
			fact: str("The fact as one short self-contained sentence, e.g. 'Ana is allergic to nuts.'"),
		}),
	},
	{
		name: "forget",
		description: "Delete a remembered fact by its id (shown in brackets in your memory list).",
		parameters: Type.Object({ id: str("Memory id") }),
	},
	{
		name: "house_list_add",
		description:
			"Add items to a house list: 'shopping' (groceries, things to buy), 'tasks' (chores, things to do around the house), or another named list.",
		parameters: Type.Object({
			list: str("List name: 'shopping', 'tasks', or another name the user gives"),
			items: strList("Items to add, each short, in the user's language"),
			assignee: opt(str("Optional: who should do it (tasks)")),
			due: opt(str("Optional: when it is due, 'YYYY-MM-DD'")),
		}),
	},
	{
		name: "house_list_remove",
		description: "Remove items from a house list (bought, done, or no longer needed).",
		parameters: Type.Object({
			list: str("List name"),
			items: strList("Items to remove (approximate text is fine)"),
		}),
	},
	{
		name: "house_list_show",
		description: "Show what is on a house list, or on all lists when no name is given.",
		parameters: Type.Object({ list: opt(str("List name (optional)")) }),
	},
	{
		name: "set_volume",
		description: "Change the speaker volume, absolutely (percent) or relatively (change).",
		parameters: Type.Object({
			percent: opt(integer("Volume 0-100")),
			change: opt(integer("Relative change in percent points, e.g. 10 or -10")),
		}),
	},
];

/** Calls a method of the daemon that takes strings and returns one string. */
function daemon(method: string, args: string[], signal?: AbortSignal): Promise<string> {
	const busctl = process.env.BALAUR_BUSCTL || "busctl";
	const argv = ["--user", "--json=short", "--timeout=25", "call", ...BUS, method];
	if (args.length > 0) argv.push("s".repeat(args.length), ...args);
	return new Promise((resolve, reject) => {
		execFile(busctl, argv, { signal, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
			if (err) {
				// "Call failed: <the daemon's message>"
				const said = String(stderr).trim().replace(/^Call failed: /, "");
				return reject(new Error(said || err.message));
			}
			try {
				resolve(String(JSON.parse(stdout).data[0]));
			} catch {
				reject(new Error(`the assistant gave no answer to ${method}`));
			}
		});
	});
}

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }], details: undefined };
}

function deadline(signal: AbortSignal | undefined): AbortSignal {
	const t = AbortSignal.timeout(TOOL_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, t]) : t;
}

function loadConfig(): any {
	const path = process.env.BALAUR_ASSISTANT_CONFIG;
	return path ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	const env = process.env;
	const news = new News(cfg.newsFeeds ?? []);
	const home = cfg.location ?? { name: "", latitude: 0, longitude: 0 };
	const searchModel: string = cfg.search?.model ?? "";
	const ours: string[] = [];
	const allowed = (name: string) => ours.includes(name) || name.startsWith(HOUSE);
	/** The house tools pi has registered: once the server answered, and only if it did. */
	const house = () =>
		pi
			.getAllTools()
			.filter((t: any) => t.name.startsWith(HOUSE) && (t.exposure ?? "direct") === "direct")
			.map((t: any) => t.name as string);

	// Our tools share the daemon's state: one at a time, in the model's order.
	const register = (spec: Spec, run: (p: any, signal: AbortSignal) => Promise<string>) => {
		ours.push(spec.name);
		pi.registerTool({
			...spec,
			label: spec.name,
			executionMode: "sequential",
			async execute(_id: string, params: any, signal: AbortSignal | undefined) {
				return text(await run(params ?? {}, deadline(signal)));
			},
		} as any);
	};

	for (const spec of daemonToolSpecs)
		register(spec, (p, signal) => daemon("AgentTool", [spec.name, JSON.stringify(p)], signal));
	register(
		{
			name: "weather",
			description: "Current weather and daily forecast. Defaults to the home location.",
			parameters: Type.Object({
				place: opt(str("Optional city name if not home")),
				days: opt(integer("Days of forecast, 1-7 (default 2: today and tomorrow)")),
			}),
		},
		async (p, signal) => JSON.stringify(await weather(home, p.place ?? "", p.days ?? 0, signal)),
	);
	register(
		{
			name: "news",
			description: "Latest news headlines from the configured feeds, optionally filtered by topic or language.",
			parameters: Type.Object({ topic: opt(str("Optional keyword")), language: opt(strEnum(["ro", "en"])) }),
		},
		async (p, signal) => JSON.stringify(await news.headlines(p.topic ?? "", p.language ?? "", signal)),
	);
	if (searchModel) {
		register(
			{
				name: "web_search",
				description:
					"Search the web for current facts, prices, opening hours, sports results, etc. Returns the top results with snippets.",
				parameters: Type.Object({ query: str("Search query") }),
			},
			async (p, signal) =>
				JSON.stringify(
					await webSearch(
						env.BALAUR_SPEECH_BASE_URL || "https://api.mistral.ai/v1",
						env.MISTRAL_API_KEY ?? "",
						searchModel,
						p.query ?? "",
						signal,
					),
				),
		);
	}

	/**
	 * Exits when the model is offered any tool but ours and the house's. pi keeps its own tools
	 * registered even when started without them; what counts is the active set,
	 * the tools declared to the model, and that a call to another is blocked (below).
	 */
	const checkTools = () => {
		const active = pi.getActiveTools();
		const foreign = active.filter((n: string) => !allowed(n));
		if (foreign.length > 0) {
			console.error(`balaur-home-agent: refusing to run: tools other than ours are active: ${foreign.join(", ")}`);
			process.exit(1);
		}
		const missing = ours.filter((n) => !active.includes(n));
		if (missing.length > 0) {
			console.error(`balaur-home-agent: refusing to run: our tools are not active: ${missing.join(", ")}`);
			process.exit(1);
		}
	};

	let rounds = 0;

	pi.on("session_start", async () => {
		checkTools();
		console.error(`balaur-home-agent: ready (tools ${ours.join(", ")})`);
	});

	pi.on("before_agent_start", async () => {
		rounds = 0;
		pi.setActiveTools([...ours, ...house()]); // back after a capped run
		checkTools();
		const ctx: TurnContext = JSON.parse(await daemon("AgentContext", []));
		return { systemPrompt: systemPrompt(ctx, ctx.lang ?? "", !!env.BALAUR_HOUSE_DEVICES) };
	});

	pi.on("turn_end", async () => {
		// The next round is the last: no tools, make it answer.
		if (++rounds === MAX_TOOL_ROUNDS - 1) pi.setActiveTools([]);
	});

	pi.on("tool_call", async (event: any) => {
		if (!allowed(event.toolName)) return { block: true, reason: "this assistant has only its own tools" };
		return undefined;
	});
}
