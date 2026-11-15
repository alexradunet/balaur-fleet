// Full-text search of the pages. Each page's text is kept in memory until its
// file changes; a few thousand small pages fit with room to spare.

const MAX_RESULTS = 50;

function fold(s) {
  return s.normalize("NFC").toLocaleLowerCase();
}

export class Search {
  constructor(folder) {
    this.folder = folder;
    this.cache = new Map(); // path -> { mtime, text, folded }
  }

  async text(page) {
    const mtime = await this.folder.mtime(page.path).catch(() => null);
    if (mtime === null) return null;
    let c = this.cache.get(page.path);
    if (!c || c.mtime !== mtime) {
      const r = await this.folder.read(page.path);
      if (!r) return null;
      c = { mtime, text: r.text, folded: fold(r.text) };
      this.cache.set(page.path, c);
    }
    return c;
  }

  // find returns the pages whose title or text holds every word of q, the
  // pages whose title matches first, each with a line around its first match.
  async find(pages, q) {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits = [];
    for (const page of pages) {
      const c = await this.text(page);
      if (!c) continue;
      const title = fold([page.title, ...page.aliases].join(" "));
      if (!words.every((w) => title.includes(w) || c.folded.includes(w))) continue;
      const inTitle = words.every((w) => title.includes(w));
      hits.push({ page, inTitle, snippet: snippet(c.text, c.folded, words) });
    }
    hits.sort((a, b) => (b.inTitle - a.inTitle) || b.page.path.localeCompare(a.page.path));
    return hits.slice(0, MAX_RESULTS);
  }
}

function snippet(text, folded, words) {
  let at = -1;
  for (const w of words) {
    const i = folded.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return "";
  // The folded text can differ in length from the text for a few letters;
  // the line around the match is near enough for a hint.
  const start = Math.max(0, text.lastIndexOf("\n", at) + 1, at - 80);
  let end = text.indexOf("\n", at);
  if (end < 0 || end - at > 120) end = Math.min(text.length, at + 120);
  return (start > 0 && text[start - 1] !== "\n" ? "…" : "") + text.slice(start, end).trim() + (end < text.length && text[end] !== "\n" ? "…" : "");
}
