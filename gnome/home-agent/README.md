# balaur-home-agent

The voice assistant's brain: the fleet's installed pi (the one `modules/agent.nix`
gives every machine) in a role of its own, the home role. The GJS daemon
(`gnome/assistant/`) starts it as a child and speaks pi's RPC protocol with it; the
model it asks is the fleet's AI entryway (`modules/ai.nix`), or Mistral without the
`agent` aspect. How it fits in is in `gnome/CONTRACT.md`, "The agent".

## Files

| File | What |
|---|---|
| `bin/balaur-home-agent` | The launcher: `pi --mode rpc` with one extension and nothing found on disk; writes pi's `mcp.json` for Home Assistant when the unit gives it a URL and a readable token file; `--test` makes one tiny request with the same model |
| `index.ts` | The extension: registers the tools, builds the system prompt for every question, enforces the locks and the round limit |
| `prompt.ts` | The system prompt, from the context the daemon gives (`AgentContext` on D-Bus) |
| `web.ts` | Weather (Open-Meteo), news (RSS feeds from the config), web search (Mistral's `web_search`) |
| `test/` | `rpc.test.mjs` runs the real pi with the extension against a model, a daemon and a Home Assistant that the test plays; `web.test.ts` parses feeds |

The tools for timers, reminders, lists, memory and volume live in the daemon (it owns
that state); the extension calls them over D-Bus with `busctl`.

## The three locks

A voice assistant that reads web pages and news must not be able to run commands or
touch files. The launcher starts pi without its own tools (`--no-builtin-tools`); the
extension exits when the model is offered any tool but ours; and a call to any other
tool is blocked. The one exception is Home Assistant's MCP server (`mcp__homeassistant__*`),
only when it is configured. `gnome/CONTRACT.md` has the details, and what the agent does
after it has read text from the web.

## Tests

The package runs them as its install check, with the real pi:

```sh
nix build .#balaur-home-agent
```

That is `node --test test/*.test.ts test/*.test.mjs` with `BALAUR_HOME_AGENT` set to
the installed launcher (see `pkgs/balaur-home-agent.nix`); `rpc.test.mjs` is skipped
without it. No network, no key, no session bus.

Nothing here is built: pi runs the TypeScript as it is, so the extension has no
dependencies of its own.
