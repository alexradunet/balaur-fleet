// The tools the model can call, with the names, descriptions and parameters
// of assistant/tools.go, so the model behaves as it did with the Go service.
//
//   daemon-side: the GJS daemon owns timers, reminders, the house lists,
//                memory and the speaker; these are forwarded to it as
//                tool_call records (see protocol.ts) and their result returned.
//   agent-side:  weather, news and web search run here (web.ts).
//
// Each tool returns the JSON the Go tool returned; the model phrases the answer.

import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Feed, type Location, News, weather, webSearch } from "./web.ts";

const str = (description: string) => Type.String({ description });
const opt = <T>(t: T) => Type.Optional(t as any);
const integer = (description: string) => Type.Integer({ description });
const strList = (description: string) => Type.Array(Type.String(), { description });
// Go declared these as {"type":"string","enum":[...]}; keep the same schema.
const strEnum = (values: string[]) => Type.Unsafe<string>({ type: "string", enum: values });

interface Spec {
	name: string;
	description: string;
	parameters: any;
}

/** The daemon-side tools (same order as tools.go). */
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

export const DAEMON_TOOLS = daemonToolSpecs.map((t) => t.name);

export interface AgentConfig {
	location: Location;
	newsFeeds: Feed[];
	searchModel: string; // "" = no web_search tool
	mistralBaseURL: string;
	mistralKey: string;
}

/** Forwards a daemon-side tool call; resolves to the result JSON text. */
export type Forward = (name: string, args: unknown, signal: AbortSignal) => Promise<string>;

// As runTool in assistant.go: each tool gets 20 seconds.
const TOOL_TIMEOUT_MS = 20_000;

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }], details: undefined };
}

function deadline(signal: AbortSignal | undefined): AbortSignal {
	const t = AbortSignal.timeout(TOOL_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, t]) : t;
}

/** All our tools as pi tool definitions. */
export function buildTools(cfg: AgentConfig, forward: Forward): ToolDefinition[] {
	const news = new News(cfg.newsFeeds ?? []);
	const local = (spec: Spec, run: (p: any, signal: AbortSignal) => Promise<unknown>): ToolDefinition =>
		({
			...spec,
			label: spec.name,
			// Our tools share the daemon's state: one at a time, in the model's order.
			executionMode: "sequential",
			async execute(_id: string, params: any, signal: AbortSignal | undefined) {
				return text(JSON.stringify(await run(params ?? {}, deadline(signal))));
			},
		}) as unknown as ToolDefinition;

	const tools: ToolDefinition[] = daemonToolSpecs.map(
		(spec) =>
			({
				...spec,
				label: spec.name,
				executionMode: "sequential",
				async execute(_id: string, params: any, signal: AbortSignal | undefined) {
					return text(await forward(spec.name, params ?? {}, deadline(signal)));
				},
			}) as unknown as ToolDefinition,
	);
	tools.push(
		local(
			{
				name: "weather",
				description: "Current weather and daily forecast. Defaults to the home location.",
				parameters: Type.Object({
					place: opt(str("Optional city name if not home")),
					days: opt(integer("Days of forecast, 1-7 (default 2: today and tomorrow)")),
				}),
			},
			(p, signal) => weather(cfg.location, p.place ?? "", p.days ?? 0, signal),
		),
		local(
			{
				name: "news",
				description: "Latest news headlines from the configured feeds, optionally filtered by topic or language.",
				parameters: Type.Object({ topic: opt(str("Optional keyword")), language: opt(strEnum(["ro", "en"])) }),
			},
			(p, signal) => news.headlines(p.topic ?? "", p.language ?? "", signal),
		),
	);
	if (cfg.searchModel) {
		tools.push(
			local(
				{
					name: "web_search",
					description:
						"Search the web for current facts, prices, opening hours, sports results, etc. Returns the top results with snippets.",
					parameters: Type.Object({ query: str("Search query") }),
				},
				(p, signal) => webSearch(cfg.mistralBaseURL, cfg.mistralKey, cfg.searchModel, p.query ?? "", signal),
			),
		);
	}
	return tools;
}
