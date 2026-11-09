// Outside information for the agent-side tools: weather (Open-Meteo, no key),
// news (RSS/Atom feeds from the config) and web search (Mistral's web_search
// tool). Only the query leaves the house, never audio. A port of
// assistant/web.go (the former Go service, in git history) and the WebSearch half of assistant/mistral.go (the former Go service, in git history).

export interface Location {
	name: string;
	latitude: number;
	longitude: number;
}

export interface Feed {
	name: string;
	url: string;
	lang: string;
}

/** fold as in the daemon: lowercase, Romanian diacritics stripped. */
export function fold(s: string): string {
	return s
		.toLowerCase()
		.replace(/[ăâ]/g, "a")
		.replace(/î/g, "i")
		.replace(/[șş]/g, "s")
		.replace(/[țţ]/g, "t")
		.trim();
}

export function truncate(s: string, n: number): string {
	const c = [...s];
	return c.length <= n ? s : `${c.slice(0, n).join("")}…`;
}

async function getJSON(url: string, signal: AbortSignal): Promise<any> {
	const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
	if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
	return res.json();
}

// WMO weather interpretation codes, as Open-Meteo reports them.
const wmo: Record<number, string> = {
	0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
	51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
	61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
	71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
	82: "violent showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm",
	96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

export async function weather(home: Location, place: string, days: number, signal: AbortSignal): Promise<unknown> {
	let loc = home;
	if (place && fold(place) !== fold(home.name ?? "")) {
		const g = await getJSON(
			`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(place)}`,
			signal,
		);
		const r = g?.results?.[0];
		if (!r) throw new Error(`place ${JSON.stringify(place)} not found`);
		loc = { name: `${r.name}, ${r.country}`, latitude: r.latitude, longitude: r.longitude };
	}
	if (!loc.latitude && !loc.longitude) throw new Error("home location is not configured");
	if (!(days >= 1 && days <= 7)) days = 2;
	const f = await getJSON(
		`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude.toFixed(6)}&longitude=${loc.longitude.toFixed(6)}` +
			`&timezone=auto&forecast_days=${days}` +
			"&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day" +
			"&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
		signal,
	);
	const c = f.current ?? {};
	const d = f.daily ?? {};
	const daily = (d.time ?? []).map((date: string, i: number) => {
		const day: Record<string, unknown> = { date };
		if (d.weather_code?.[i] !== undefined) day.sky = wmo[d.weather_code[i]] ?? "";
		if (d.temperature_2m_max?.[i] !== undefined && d.temperature_2m_min?.[i] !== undefined) {
			day.min_c = d.temperature_2m_min[i];
			day.max_c = d.temperature_2m_max[i];
		}
		if (d.precipitation_probability_max?.[i] !== undefined) day.precip_chance_pct = d.precipitation_probability_max[i];
		if (d.precipitation_sum?.[i] !== undefined) day.precip_mm = d.precipitation_sum[i];
		if (d.wind_speed_10m_max?.[i] !== undefined) day.wind_max_kmh = d.wind_speed_10m_max[i];
		return day;
	});
	return {
		place: loc.name,
		now: {
			temp_c: c.temperature_2m ?? 0,
			feels_like_c: c.apparent_temperature ?? 0,
			humidity_pct: c.relative_humidity_2m ?? 0,
			sky: wmo[c.weather_code ?? 0] ?? "",
			precip_mm: c.precipitation ?? 0,
			wind_kmh: c.wind_speed_10m ?? 0,
		},
		daily,
	};
}

// ---- news ----

export interface Headline {
	title: string;
	source: string;
	summary?: string;
	time: string; // RFC 3339; Go's zero time when the feed gave none
	lang: string;
}

const ZERO_TIME = "0001-01-01T00:00:00Z";

const MONTHS: Record<string, number> = {
	Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
// Zone names Go's time.Parse knows the offset of here (others count as UTC, as in Go).
const ZONES: Record<string, number> = { EET: 120, EEST: 180 };

/** RFC 1123 (numeric or named zone) or RFC 3339; null when neither. */
export function parseFeedTime(s: string | undefined): Date | null {
	s = (s ?? "").trim();
	const m = s.match(/^\w{3}, (\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}|[A-Z]{1,5})$/);
	if (m) {
		const mon = MONTHS[m[2]];
		if (mon === undefined) return null;
		let off = 0;
		if (/^[+-]/.test(m[7])) {
			const sign = m[7][0] === "-" ? -1 : 1;
			off = sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3, 5)));
		} else {
			off = ZONES[m[7]] ?? 0;
		}
		const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
		return new Date(utc - off * 60000);
	}
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
		const d = new Date(s);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Text of an XML element's content: CDATA unwrapped, the XML entities decoded. */
function xmlText(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/&/g, "&amp;")) // keep CDATA literal through decoding
		.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (e, n: string) => {
			if (n[0] === "#") {
				const code = n[1] === "x" || n[1] === "X" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
				try {
					return String.fromCodePoint(code);
				} catch {
					return e;
				}
			}
			return ENTITIES[n.toLowerCase()] ?? e;
		});
}

/** The first child element with this local name (any namespace prefix), or "". */
function child(block: string, name: string): string {
	const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, "i");
	return xmlText(block.match(re)?.[1] ?? "");
}

export function stripTags(s: string): string {
	return s.replace(/<[^>]*>?/g, "").split(/\s+/).filter(Boolean).join(" ");
}

/** RSS 2.0 items and Atom entries, as the Go decoder read them. */
export function parseFeed(xml: string, feed: Feed): Headline[] {
	const out: Headline[] = [];
	const add = (title: string, summary: string, t: Date | null) => {
		const h: Headline = {
			title: stripTags(title),
			source: feed.name,
			time: t ? t.toISOString().replace(".000Z", "Z") : ZERO_TIME,
			lang: feed.lang,
		};
		const sum = truncate(stripTags(summary), 240);
		if (sum) h.summary = sum;
		out.push(h);
	};
	for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)) {
		const b = m[1];
		add(child(b, "title"), child(b, "description"), parseFeedTime(child(b, "pubDate")) ?? parseFeedTime(child(b, "date")));
	}
	for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi)) {
		const b = m[1];
		add(child(b, "title"), child(b, "summary"), parseFeedTime(child(b, "published")) ?? parseFeedTime(child(b, "updated")));
	}
	return out;
}

export class News {
	private cache: Headline[] = [];
	private at = 0;

	private feeds: Feed[];

	constructor(feeds: Feed[]) {
		this.feeds = feeds;
	}

	private async fetchFeed(f: Feed, signal: AbortSignal): Promise<Headline[]> {
		const res = await fetch(f.url, { headers: { "User-Agent": "balaur-assistant/0.1 (+home)" }, signal });
		if (!res.ok) throw new Error(`${f.url}: ${res.status} ${res.statusText}`);
		return parseFeed(await res.text(), f);
	}

	async headlines(topic: string, lang: string, signal: AbortSignal): Promise<unknown> {
		if (Date.now() - this.at >= 10 * 60 * 1000) {
			const results = await Promise.allSettled(this.feeds.map((f) => this.fetchFeed(f, signal)));
			const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
			if (all.length === 0 && this.feeds.length > 0) throw new Error("no news feed could be read");
			all.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
			this.cache = all;
			this.at = Date.now();
		}
		const pick = (lang: string, topic: string) => {
			const ft = fold(topic);
			const out: Omit<Headline, "lang">[] = [];
			for (const h of this.cache) {
				if (lang && h.lang && h.lang !== lang) continue;
				if (ft && !fold(`${h.title} ${h.summary ?? ""}`).includes(ft)) continue;
				const { lang: _, ...rest } = h;
				out.push(rest);
				if (out.length === 8) break;
			}
			return out;
		};
		// Loosen the filter step by step rather than answer "no news": a topic in
		// the other language's feeds, then the latest headlines.
		for (const [l, t] of [
			[lang, topic],
			["", topic],
			[lang, ""],
			["", ""],
		]) {
			const out = pick(l, t);
			if (out.length > 0) return { filter: { language: l, topic: t }, headlines: out };
		}
		throw new Error("the news feeds are empty");
	}
}

// ---- web search ----

/**
 * Asks a question with Mistral's web_search tool (the Conversations API) and
 * returns the answer with its sources, for the main model to phrase.
 */
export async function webSearch(
	baseURL: string,
	key: string,
	model: string,
	query: string,
	signal: AbortSignal,
): Promise<unknown> {
	const res = await fetch(`${baseURL.replace(/\/+$/, "")}/conversations`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model,
			inputs: query,
			tools: [{ type: "web_search" }],
			store: false,
			instructions:
				"Search the web and answer factually and briefly (a few sentences), with dates and numbers where relevant.",
		}),
		signal,
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`POST /v1/conversations: ${res.status} ${res.statusText}: ${truncate(body, 300)}`);
	let out: any;
	try {
		out = JSON.parse(body);
	} catch (e) {
		throw new Error(`web search: bad response: ${(e as Error).message}`);
	}
	let text = "";
	const sources: string[] = [];
	for (const o of out.outputs ?? []) {
		if (o.type !== "message.output") continue;
		if (typeof o.content === "string") {
			text += o.content;
			continue;
		}
		for (const c of Array.isArray(o.content) ? o.content : []) {
			if (c.type === "text") text += c.text ?? "";
			else if (c.type === "tool_reference" && c.title) sources.push(c.title);
		}
	}
	if (!text) throw new Error("web search: no answer");
	return { answer: text.trim(), sources: sources.length ? sources : null };
}
