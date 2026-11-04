// Feed parsing for the news tool (what encoding/xml did in web.go).

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed, parseFeedTime, stripTags } from "../src/web.ts";

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
