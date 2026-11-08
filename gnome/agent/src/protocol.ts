// The JSON-lines protocol between the GJS daemon and this agent (one object
// per line on stdin/stdout; stderr is for logs). See gnome/CONTRACT.md:
//
//   agent  → daemon {"type":"ready","tools":[...]}
//   daemon → agent  {"type":"prompt","id":"p1","text":"...","lang":"ro","context":{...}}
//   agent  → daemon {"type":"tool_call","id":"c1","prompt":"p1","name":"set_timer","args":{...}}
//   daemon → agent  {"type":"tool_result","id":"c1","ok":true,"result":"..."}  (or ok:false, error)
//   agent  → daemon {"type":"reply","id":"p1","text":"...","lang":"ro"}  (or {"type":"error","id":"p1","message":"..."})
//   daemon → agent  {"type":"abort","id":"p1"}  |  {"type":"reset"}
//   daemon → agent  {"type":"test","id":"t1"}  →  {"type":"test_result","id":"t1","error":""}  ("" = fine)
// ready also carries pi's model catalog ("models") and, when the configured
// model cannot be used, "error" (the agent then answers every prompt with it).

import type { Readable, Writable } from "node:stream";
import { BalaurAgent } from "./agent.ts";
import { systemPrompt, type TurnContext } from "./prompt.ts";

export type Send = (msg: Record<string, unknown>) => void;

/** Splits a byte stream into lines on LF only (U+2028 is valid inside JSON). */
export async function* lines(input: Readable): AsyncGenerator<string> {
	let buf = "";
	const decoder = new TextDecoder();
	for await (const chunk of input) {
		buf += decoder.decode(chunk as Buffer, { stream: true });
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (line.trim()) yield line;
		}
	}
	if (buf.trim()) yield buf;
}

export function writer(out: Writable): Send {
	return (msg) => out.write(`${JSON.stringify(msg)}\n`);
}

interface Pending {
	resolve: (text: string) => void;
	reject: (e: Error) => void;
}

/**
 * Serves one daemon. Prompts run one at a time (the daemon asks one thing at
 * a time); tool calls for daemon-side tools go out with an id and wait here.
 */
export class Server {
	private calls = new Map<string, Pending>();
	private nextCall = 0;
	private current: string | null = null; // id of the prompt being answered
	private queue: Promise<void> = Promise.resolve();

	private agent: BalaurAgent;
	private send: Send;
	private test: () => Promise<string>;

	constructor(agent: BalaurAgent, send: Send, test: () => Promise<string> = async () => "") {
		this.agent = agent;
		this.send = send;
		this.test = test;
	}

	/** For tools.ts: forward a daemon-side tool call and wait for its result. */
	forward = (name: string, args: unknown, signal: AbortSignal): Promise<string> => {
		const id = `c${++this.nextCall}`;
		return new Promise<string>((resolve, reject) => {
			const onAbort = () => {
				this.calls.delete(id);
				reject(new Error(signal.reason?.message ?? "aborted"));
			};
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			this.calls.set(id, {
				resolve: (t) => {
					signal.removeEventListener("abort", onAbort);
					resolve(t);
				},
				reject: (e) => {
					signal.removeEventListener("abort", onAbort);
					reject(e);
				},
			});
			this.send({ type: "tool_call", id, prompt: this.current, name, args });
		});
	};

	handle(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			console.error(`balaur-agent: bad line from the daemon: ${(e as Error).message}`);
			return;
		}
		switch (msg.type) {
			case "prompt":
				// One at a time, in order.
				this.queue = this.queue.then(() => this.prompt(msg));
				break;
			case "tool_result": {
				const p = this.calls.get(msg.id);
				if (!p) break;
				this.calls.delete(msg.id);
				if (msg.ok) p.resolve(typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result ?? null));
				else p.reject(new Error(msg.error || "tool failed"));
				break;
			}
			case "abort":
				if (this.current && (!msg.id || msg.id === this.current)) {
					void this.agent.abort();
					for (const [id, p] of this.calls) {
						this.calls.delete(id);
						p.reject(new Error("aborted"));
					}
				}
				break;
			case "test":
				// The app's "Test" button: one tiny request with the current settings.
				void this.test().then((error) => this.send({ type: "test_result", id: msg.id, error }));
				break;
			case "reset":
				this.queue = this.queue.then(() => this.agent.reset()).catch((e) => console.error(`balaur-agent: reset: ${e.message}`));
				break;
			default:
				console.error(`balaur-agent: unknown message type ${JSON.stringify(msg.type)}`);
		}
	}

	private async prompt(msg: any): Promise<void> {
		const id = String(msg.id ?? "");
		const lang = msg.lang === "en" || msg.lang === "ro" ? msg.lang : "";
		this.current = id;
		const t0 = Date.now();
		try {
			const ctx: TurnContext = msg.context ?? {};
			const r = await this.agent.ask(String(msg.text ?? ""), systemPrompt(ctx, lang));
			if (r.aborted) this.send({ type: "error", id, message: "aborted", aborted: true });
			else if (r.error) this.send({ type: "error", id, message: r.error });
			else this.send({ type: "reply", id, text: r.text, lang });
		} catch (e) {
			this.send({ type: "error", id, message: (e as Error).message });
		} finally {
			this.current = null;
			console.error(`balaur-agent: prompt ${id}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		}
	}
}
