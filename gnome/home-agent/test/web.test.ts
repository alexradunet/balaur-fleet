// Feed parsing for the news tool (what encoding/xml did in web.go), and the
// tools that fetch (news, weather, web search) against servers played here.

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { MAX_BODY_BYTES, News, OPEN_METEO, parseFeed, parseFeedTime, stripTags, weather, webSearch } from "../web.ts";

const feed = { name: "Digi24", url: "x", lang: "ro" };

test("RSS items: CDATA, entities, tags stripped, RFC 1123 dates", () => {
	const xml = `<?xml version="1.0"?><rss><channel><title>Digi</title>
		<item><title><![CDATA[Ploaie &amp; vânt <b>azi</b>]]></title>
		<description>&lt;p&gt;Cod galben&lt;/p&gt; în &#x218;tefăneşti</description>
		<pubDate>Wed, 04 Nov 2026 16:13:20 +0200</pubDate></item>
		<item><title>Fără dată</title><dc:date>2026-11-04T10:00:00Z</dc:date></item></channel></rss>`;
	const h = parseFeed(xml, feed);
	assert.equal(h.length, 2);
	assert.equal(h[0].title, "Ploaie &amp; vânt azi");
	assert.equal(h[0].summary, "Cod galben în Ștefăneşti");
	assert.equal(h[0].time, "2026-11-04T14:13:20Z");
	assert.equal(h[1].time, "2026-11-04T10:00:00Z");
	assert.equal(h[1].summary, undefined);
});

test("Atom entries and unknown dates", () => {
	const xml = `<feed><entry><title type="html">A &lt;i&gt;b&lt;/i&gt;</title><summary>s</summary>
		<updated>2026-11-01T08:00:00+02:00</updated></entry><entry><title>x</title><published>yesterday</published></entry></feed>`;
	const h = parseFeed(xml, feed);
	assert.equal(h[0].title, "A b");
	assert.equal(h[0].time, "2026-11-01T06:00:00Z");
	assert.equal(h[1].time, "0001-01-01T00:00:00Z");
	assert.equal(parseFeedTime("Mon, 2 Nov 2026 08:00:00 GMT")?.toISOString(), "2026-11-02T08:00:00.000Z");
	assert.equal(stripTags("  a <br/> b  "), "a b");
});

// ---- servers played here ----

/** A server on a free port; `handler` answers every request, `hits` counts them by path. */
async function serve(handler: http.RequestListener) {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url ?? "");
		handler(req, res);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as any).port}`;
	return { base, hits, close: () => server.closeAllConnections() ?? new Promise((r) => server.close(r)) };
}

const rss = (...items: string[]) =>
	`<rss><channel>${items.map((i) => `<item>${i}</item>`).join("")}</channel></rss>`;
const signal = () => AbortSignal.timeout(10_000);

test("News.headlines loosens the filter step by step and caches the feeds", async () => {
	const ro = await serve((_, res) =>
		res.end(rss(
			"<title>Ploaie în București</title><pubDate>Wed, 04 Nov 2026 16:00:00 +0200</pubDate>",
			"<title>Fotbal: derby</title><pubDate>Wed, 04 Nov 2026 15:00:00 +0200</pubDate>",
		)),
	);
	const en = await serve((_, res) =>
		res.end(rss("<title>Storm warning</title><description>wind</description><pubDate>Wed, 04 Nov 2026 17:00:00 +0200</pubDate>")),
	);
	try {
		const news = new News([
			{ name: "Digi24", url: `${ro.base}/feed`, lang: "ro" },
			{ name: "BBC", url: `${en.base}/feed`, lang: "en" },
		]);
		const titles = (r: any) => r.headlines.map((h: any) => h.title);
		// topic and language both match: the Romanian feed only, diacritics folded
		let r: any = await news.headlines("bucuresti", "ro", signal());
		assert.deepEqual(r.filter, { language: "ro", topic: "bucuresti" });
		assert.deepEqual(titles(r), ["Ploaie în București"]);
		// the topic is only in the other language: the language is dropped
		r = await news.headlines("storm", "ro", signal());
		assert.deepEqual(r.filter, { language: "", topic: "storm" });
		assert.deepEqual(titles(r), ["Storm warning"]);
		// no such topic: the latest headlines in the language
		r = await news.headlines("nothing like it", "ro", signal());
		assert.deepEqual(r.filter, { language: "ro", topic: "" });
		assert.deepEqual(titles(r), ["Ploaie în București", "Fotbal: derby"], "newest first");
		// no such language either: everything, newest first
		r = await news.headlines("", "fr", signal());
		assert.deepEqual(r.filter, { language: "", topic: "" });
		assert.deepEqual(titles(r), ["Storm warning", "Ploaie în București", "Fotbal: derby"]);
		assert.equal(r.headlines[0].lang, undefined, "the language is not repeated per headline");
		assert.deepEqual([ro.hits.length, en.hits.length], [1, 1], "four questions, one fetch of each feed");
	} finally {
		await ro.close();
		await en.close();
	}
});

test("News.headlines: a hanging feed does not hold up the others, and an oversized one is dropped", async () => {
	const good = await serve((_, res) => res.end(rss("<title>Bună</title>")));
	const hang = await serve(() => {});
	const huge = await serve((_, res) => {
		res.write("<rss><channel>");
		res.end(" ".repeat(MAX_BODY_BYTES + 1024));
	});
	try {
		const news = new News(
			[
				{ name: "hang", url: `${hang.base}/f`, lang: "ro" },
				{ name: "huge", url: `${huge.base}/f`, lang: "ro" },
				{ name: "good", url: `${good.base}/f`, lang: "ro" },
			],
			300,
		);
		const started = Date.now();
		const r: any = await news.headlines("", "ro", signal());
		assert.ok(Date.now() - started < 5000, "the 20 s of the whole tool were not used up");
		assert.deepEqual(r.headlines.map((h: any) => h.source), ["good"]);
		const none = new News([{ name: "hang", url: `${hang.base}/f`, lang: "ro" }], 200);
		await assert.rejects(none.headlines("", "", signal()), /no news feed could be read/);
	} finally {
		await good.close();
		await hang.close();
		await huge.close();
	}
});

test("weather: home without geocoding, another place with it, and its errors", async () => {
	const api = await serve((req, res) => {
		const url = new URL(req.url!, "http://x");
		res.setHeader("Content-Type", "application/json");
		if (url.pathname === "/geo") {
			const name = url.searchParams.get("name");
			return res.end(JSON.stringify(name === "Cluj" ? { results: [{ name: "Cluj-Napoca", country: "Romania", latitude: 46.77, longitude: 23.59 }] } : {}));
		}
		res.end(JSON.stringify({
			current: { temperature_2m: 7.5, apparent_temperature: 5, relative_humidity_2m: 80, weather_code: 61, precipitation: 0.4, wind_speed_10m: 12 },
			daily: { time: ["2026-11-10", "2026-11-11"], weather_code: [61, 3], temperature_2m_max: [9, 11], temperature_2m_min: [3, 4], precipitation_probability_max: [70, 10] },
		}));
	});
	try {
		const endpoints = { geocoding: `${api.base}/geo`, forecast: `${api.base}/forecast` };
		const home = { name: "București", latitude: 44.43, longitude: 26.1 };
		const w: any = await weather(home, "bucuresti", 0, signal(), endpoints);
		assert.equal(w.place, "București");
		assert.equal(w.now.temp_c, 7.5);
		assert.equal(w.now.sky, "light rain");
		assert.deepEqual(w.daily[1], { date: "2026-11-11", sky: "overcast", min_c: 4, max_c: 11, precip_chance_pct: 10 });
		assert.deepEqual(api.hits.map((h) => h.split("?")[0]), ["/forecast"], "the home place is not geocoded");
		assert.match(api.hits[0], /latitude=44\.430000&longitude=26\.100000.*forecast_days=2/, "two days by default");
		const far: any = await weather(home, "Cluj", 3, signal(), endpoints);
		assert.equal(far.place, "Cluj-Napoca, Romania");
		assert.match(api.hits.at(-1)!, /latitude=46\.770000.*forecast_days=3/);
		await assert.rejects(weather(home, "Nowhere", 1, signal(), endpoints), /place "Nowhere" not found/);
		await assert.rejects(weather({ name: "", latitude: 0, longitude: 0 }, "", 1, signal(), endpoints), /not configured/);
		assert.equal(OPEN_METEO.forecast, "https://api.open-meteo.com/v1/forecast", "the real endpoints are the default");
	} finally {
		await api.close();
	}
});

test("webSearch: the answer and its sources, the key, and the failures", async () => {
	let seen: any;
	let reply: (res: http.ServerResponse) => void = () => {};
	const api = await serve((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
			reply(res);
		});
	});
	try {
		reply = (res) =>
			res.end(JSON.stringify({ outputs: [
				{ type: "tool.execution" },
				{ type: "message.output", content: [{ type: "text", text: "Deschis până la 18. " }, { type: "tool_reference", title: "Site oficial" }] },
			] }));
		const ok: any = await webSearch(`${api.base}/v1/`, "k3y", "search-model", "program magazin", signal());
		assert.deepEqual(ok, { answer: "Deschis până la 18.", sources: ["Site oficial"] });
		assert.equal(seen.url, "/v1/conversations");
		assert.equal(seen.auth, "Bearer k3y");
		assert.equal(seen.body.model, "search-model");
		assert.equal(seen.body.inputs, "program magazin");
		assert.deepEqual(seen.body.tools, [{ type: "web_search" }]);
		reply = (res) => res.end(JSON.stringify({ outputs: [{ type: "message.output", content: "doar text" }] }));
		assert.deepEqual(await webSearch(api.base, "k", "m", "q", signal()), { answer: "doar text", sources: null });
		reply = (res) => res.end(JSON.stringify({ outputs: [] }));
		await assert.rejects(webSearch(api.base, "k", "m", "q", signal()), /no answer/);
		reply = (res) => res.end("not json");
		await assert.rejects(webSearch(api.base, "k", "m", "q", signal()), /bad response/);
		reply = (res) => {
			res.writeHead(401, "Unauthorized");
			res.end("bad key");
		};
		await assert.rejects(webSearch(api.base, "k", "m", "q", signal()), /401 Unauthorized: bad key/);
		reply = (res) => res.end(" ".repeat(MAX_BODY_BYTES + 1024));
		await assert.rejects(webSearch(api.base, "k", "m", "q", signal()), /longer than/);
	} finally {
		await api.close();
	}
});
