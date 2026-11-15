// A page's text as HTML: markdown, with Obsidian's wikilinks. Where a link
// leads is not decided here: `lifelog index` resolved each target (the title
// key is Go's), and the page's own map is passed in.

import MarkdownIt from "markdown-it";

// splitFrontmatter returns the body of a page without its properties block.
export function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) return { front: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { front: "", body: text };
  const after = text.indexOf("\n", end + 4);
  if (after !== -1 && text.slice(end + 4, after).trim() !== "") return { front: "", body: text };
  return { front: text.slice(4, end + 1), body: after === -1 ? "" : text.slice(after + 1) };
}

// The whole link: an optional ! (an embed), the target, and the rest
// (#heading, ^block, |text) up to ]]. The same grammar as `lifelog`.
const WIKILINK = /^(!?)\[\[([^\[\]|#^\n]+)([^\[\]\n]*)\]\]/;

export function encPath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

export function pageHref(p) {
  if (p.startsWith("journal/")) return `/day/${p.slice(8, 18)}`;
  return `/p/${encPath(p)}`;
}

function wikilinks(md) {
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const src = state.src.slice(state.pos);
    if (!src.startsWith("[[") && !src.startsWith("![[")) return false;
    const m = WIKILINK.exec(src);
    if (!m) return false;
    if (!silent) {
      const [, bang, target, rest] = m;
      const pipe = rest.indexOf("|");
      const label = pipe >= 0 ? rest.slice(pipe + 1) : target + (rest.startsWith("#") ? rest : "");
      const links = state.env.links ?? {};
      const resolved = links[target];
      const image = state.env.images?.get(target);
      if (bang && image) {
        const t = state.push("wiki_image", "img", 0);
        t.attrs = [["src", `/raw/${encPath(image)}`], ["alt", label]];
      } else {
        const open = state.push("link_open", "a", 1);
        if (resolved) {
          open.attrs = [["href", pageHref(resolved)], ["class", "wikilink"]];
        } else {
          open.attrs = [["href", `/new?title=${encodeURIComponent(target.trim())}`], ["class", "wikilink missing"]];
        }
        state.push("text", "", 0).content = label;
        state.push("link_close", "a", -1);
      }
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.wiki_image = (tokens, i) => {
    const t = tokens[i];
    const esc = md.utils.escapeHtml;
    return `<img src="${esc(t.attrGet("src"))}" alt="${esc(t.attrGet("alt"))}" loading="lazy">`;
  };
}

// #tag becomes a link to a search for it.
function tags(md) {
  md.inline.ruler.push("tag", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x23 /* # */) return false;
    const before = state.pos === 0 ? " " : state.src[state.pos - 1];
    if (!/\s|\(/.test(before)) return false;
    const m = /^#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/u.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const open = state.push("link_open", "a", 1);
      open.attrs = [["href", `/search?q=${encodeURIComponent(m[0])}`], ["class", "tag"]];
      state.push("text", "", 0).content = m[0];
      state.push("link_close", "a", -1);
    }
    state.pos += m[0].length;
    return true;
  });
}

// html:false: a page's text never becomes markup of its own.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(wikilinks).use(tags);

// The default validator lets only http(s), mailto and some data images through.
export function render(body, { links = {}, images = new Map() } = {}) {
  return md.render(body, { links, images });
}
