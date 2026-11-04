// The pi SDK session behind the assistant: Mistral through pi's provider, only
// our tools, nothing discovered from the filesystem, history in memory.

import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// Pi's own tools. None may ever be reachable: a voice assistant fed web pages
// and news must not be able to run commands or touch files.
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "codemode", "tool_search"];

// As assistant.go: a quiet period after which the conversation starts afresh,
// and a cap on model rounds per question (the last one gets no tools).
export const HISTORY_TTL_MS = 5 * 60 * 1000;
export const MAX_TOOL_ROUNDS = 6;

/**
 * A resource loader that discovers nothing: no extensions, skills, prompt
 * templates, themes or context files. The system prompt is ours and changes
 * every turn (setPrompt, then the session rebuilds it).
 */
class FixedResources implements ResourceLoader {
	prompt = "";
	getExtensions() {
		return { extensions: [], errors: [], runtime: createExtensionRuntime() };
	}
	getSkills() {
		return { skills: [], diagnostics: [] };
	}
	getPrompts() {
		return { prompts: [], diagnostics: [] };
	}
	getThemes() {
		return { themes: [], diagnostics: [] };
	}
	getAgentsFiles() {
		return { agentsFiles: [] };
	}
	getSystemPrompt() {
		return this.prompt;
	}
	getSystemPromptSource() {
		return undefined;
	}
	getAppendSystemPrompt() {
		return [];
	}
	getAppendSystemPromptSources() {
		return [];
	}
	extendResources() {}
	async reload() {}
}

export interface DuetSessionOptions {
	modelRuntime: ModelRuntime;
	model: Model<any>;
	tools: ToolDefinition[];
	/** An empty private directory: the session's nominal working directory. */
	cwd: string;
}

export interface Reply {
	text: string;
	aborted: boolean;
	error?: string;
}

/** Text of an assistant message's text blocks. */
function messageText(m: any): string {
	if (typeof m?.content === "string") return m.content;
	return (m?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
}

export class DuetAgent {
	private session: AgentSession | null = null;
	private resources = new FixedResources();
	private lastTurn = 0;
	readonly toolNames: string[];

	private opts: DuetSessionOptions;

	constructor(opts: DuetSessionOptions) {
		this.opts = opts;
		this.toolNames = opts.tools.map((t) => t.name);
	}

	/** Creates the session and checks that only our tools exist; throws otherwise. */
	async start(): Promise<void> {
		this.session?.dispose();
		this.session = null;
		const { session } = await createAgentSession({
			cwd: this.opts.cwd,
			agentDir: this.opts.cwd,
			model: this.opts.model,
			thinkingLevel: "off",
			modelRuntime: this.opts.modelRuntime,
			resourceLoader: this.resources,
			// The allowlist both activates and registers: nothing else is even registered.
			tools: this.toolNames,
			excludeTools: BUILTIN_TOOLS,
			customTools: this.opts.tools,
			sessionManager: SessionManager.inMemory(this.opts.cwd),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true },
				retry: { enabled: true, maxRetries: 2 },
			}),
		});
		this.session = session;
		this.checkTools();
	}

	/** Refuses to run with any tool but ours, active or merely registered. */
	checkTools(): void {
		const s = this.session!;
		const ours = new Set(this.toolNames);
		const active = s.getActiveToolNames();
		const registered = s.getAllTools().map((t) => t.name);
		const callable = s.getCallableToolNames();
		const foreign = [...new Set([...active, ...registered, ...callable])].filter((n) => !ours.has(n));
		if (foreign.length > 0) throw new Error(`refusing to run: pi tools other than ours are present: ${foreign.join(", ")}`);
		const missing = this.toolNames.filter((n) => !active.includes(n));
		if (missing.length > 0) throw new Error(`our tools are not active: ${missing.join(", ")}`);
	}

	get activeToolNames(): string[] {
		return this.session?.getActiveToolNames() ?? [];
	}

	get systemPrompt(): string {
		return this.session?.systemPrompt ?? "";
	}

	get messageCount(): number {
		return this.session?.messages.length ?? 0;
	}

	/** Forgets the conversation. */
	async reset(): Promise<void> {
		await this.start();
		this.lastTurn = 0;
	}

	/** One question: the system prompt for this turn, then the model and its tools. */
	async ask(text: string, prompt: string): Promise<Reply> {
		if (!this.session || (this.lastTurn && Date.now() - this.lastTurn > HISTORY_TTL_MS)) await this.reset();
		const s = this.session!;
		this.resources.prompt = prompt;
		// Rebuilds the system prompt from the loader (and restores the tools
		// after a capped run); the change is declared before the next request.
		s.setActiveToolsByName(this.toolNames);
		this.checkTools();

		let rounds = 0;
		let last: any = null;
		const unsubscribe = s.subscribe((ev: any) => {
			if (ev.type === "message_end" && ev.message?.role === "assistant") last = ev.message;
			if (ev.type === "turn_end" && ++rounds === MAX_TOOL_ROUNDS - 1) {
				// Last round: no tools, make it answer.
				s.setActiveToolsByName([]);
			}
		});
		try {
			await s.prompt(text);
		} finally {
			unsubscribe();
			// Tools back for the next question if this one hit the cap.
			if (rounds >= MAX_TOOL_ROUNDS - 1) s.setActiveToolsByName(this.toolNames);
		}
		if (!last) return { text: "", aborted: false, error: "the model gave no answer" };
		if (last.stopReason === "aborted") return { text: "", aborted: true };
		if (last.stopReason === "error") return { text: "", aborted: false, error: last.errorMessage || "the model failed" };
		const reply = messageText(last).trim();
		if (!reply) return { text: "", aborted: false, error: "the model gave no answer" };
		this.lastTurn = Date.now();
		return { text: reply, aborted: false };
	}

	async abort(): Promise<void> {
		await this.session?.abort();
	}

	dispose(): void {
		this.session?.dispose();
		this.session = null;
	}
}
