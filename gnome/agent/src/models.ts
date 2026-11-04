// Model selection through pi's own ModelRuntime: credentials and catalog in
// memory (no auth.json/models.json), the provider/model/server/key the daemon
// passes (its GSettings + keyring), and the catalog for the app's picker.

import { InMemoryCredentialStore, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface LLMSettings {
	provider: string; // a pi provider id, e.g. "mistral"
	model: string;
	baseUrl: string; // "" = the provider's default
	key: string;
}

export async function createRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

/**
 * Applies the settings to the runtime and returns the model, or throws with a
 * human message. A known provider with a base URL is routed there (models and
 * auth unchanged); an unknown provider with a base URL is taken as an
 * OpenAI-compatible server offering just this model.
 */
export async function selectModel(rt: ModelRuntime, s: LLMSettings): Promise<Model<any>> {
	if (!s.provider) throw new Error("no model provider is set");
	if (!s.model) throw new Error("no model is set");
	const known = rt.getProvider(s.provider) !== undefined;
	if (s.baseUrl && known) {
		rt.registerProvider(s.provider, { baseUrl: s.baseUrl });
	} else if (s.baseUrl) {
		rt.registerProvider(s.provider, {
			name: s.provider,
			baseUrl: s.baseUrl,
			api: "openai-completions",
			apiKey: s.key || "none",
			models: [
				{
					id: s.model,
					name: s.model,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				} as any,
			],
		});
	} else if (!known) {
		throw new Error(`unknown model provider ${JSON.stringify(s.provider)} (set a server URL for an OpenAI-compatible one)`);
	}
	if (s.key) await rt.setRuntimeApiKey(s.provider, s.key);
	const model = rt.getModel(s.provider, s.model);
	if (!model) throw new Error(`${s.provider} has no model ${JSON.stringify(s.model)}`);
	return model;
}

/** pi's catalog: {"providers":[{"id","name","models":[{"id","name"}]}]}. */
export function catalog(rt: ModelRuntime) {
	return {
		providers: rt
			.getProviders()
			.map((p) => ({
				id: p.id,
				name: p.name,
				models: rt.getModels(p.id).map((m) => ({ id: m.id, name: m.name })),
			}))
			.filter((p) => p.models.length > 0),
	};
}

/** One tiny request: "" when the model answers, else the error. */
export async function testModel(rt: ModelRuntime, model: Model<any>): Promise<string> {
	try {
		const m = await rt.completeSimple(
			model,
			{ messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }] } as any,
			{ signal: AbortSignal.timeout(30_000) } as any,
		);
		if (m.stopReason === "error" || m.stopReason === "aborted") return m.errorMessage || `request ${m.stopReason}`;
		return "";
	} catch (e) {
		return (e as Error).message;
	}
}
