# duet-assistant (GJS)

The household's voice assistant ("Hey Jarvis") as a GNOME session service:
a `Gio.Application` (`org.balaur.Assistant`) started by the systemd user unit
`duet-assistant.service`. It replaced a Go service and keeps its config JSON
and state files; the API is D-Bus only (see `gnome/CONTRACT.md`). The model and its tools run in a separate process,
`duet-agent` (`gnome/agent/`, pi SDK), which this daemon spawns.

## Layout

| File | What |
|---|---|
| `main.js`, `application.js` | Entry point; the `Gio.Application`, `app.stop`, alarm notifications |
| `dbus.js` | `org.balaur.Assistant1` (properties, methods, `Error.Failed`) |
| `assistant.js` | The pipeline: wake word → listen → transcribe → agent → speak; alarms; Snapshot |
| `agent.js` | Spawns `duet-agent` (`$DUET_AGENT`) and speaks its JSON-lines protocol |
| `tools.js`, `timers.js` | The daemon-side tools the agent forwards (timers, reminders, lists, memory, volume) |
| `store.js`, `gojson.js` | `house.json`, `memory.json`, `reminders.json`, byte-compatible with Go's encoding/json |
| `settings.js`, `org.balaur.Assistant.gschema.xml` | GSettings (model, servers, voices; changes debounced 1.5 s) and keyring API keys |
| `audio.js` | GStreamer capture (`pipewiresrc` from `duet-mic`, mic watchdog), playback (`pipewiresink`, `media.role=Assistant`), earcons, `wpctl` volume |
| `wyoming.js` | Client for openWakeWord's Wyoming server (127.0.0.1:10400), reconnects when it restarts |
| `mistral.js`, `http.js` | Voxtral speech-to-text and text-to-speech over libsoup 3 |
| `vad.js`, `lang.js`, `config.js`, `util.js` | End of speech, Romanian/English heuristics, config, helpers |
| `tests/` | Tests (no framework): `run.js` runs every `test_*.js`; `fake-agent.js` stands in for `duet-agent` |

## Tests

```sh
nix build --impure --expr 'let p = (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux; in p.callPackage ./pkgs/duet-assistant-gjs.nix {}'
./result/libexec/duet-assistant-tests            # all (about 15 s); a name filter as argument runs fewer
```

They use test elements instead of PipeWire, fake Mistral/Wyoming servers and
the fake agent: no sound, no network, no key. On the household session,
`DUET_TEST_PIPEWIRE=1` adds two tests with the real `duet-mic` and
`pipewiresink` (silence only). The agent's own tests run when its package
builds (`node --test test/*.test.ts` in `gnome/agent/`).

## Running by hand

The installed assistant is live; while this runs, both answer "Hey Jarvis",
so keep it short. As the household user, on a copy of the state:

```sh
sudo -u home env XDG_RUNTIME_DIR=/run/user/1002 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1002/bus \
  STATE_DIRECTORY=/tmp/copy-of-state CREDENTIALS_DIRECTORY=/tmp/dir-with-llm-key \
  DUET_ASSISTANT_CONFIG=/nix/store/...-duet-assistant.json TZ=Europe/Bucharest \
  ./result/bin/duet-assistant

gdbus introspect --session --dest org.balaur.Assistant --object-path /org/balaur/Assistant
gdbus call --session --timeout 120 --dest org.balaur.Assistant --object-path /org/balaur/Assistant \
  --method org.balaur.Assistant1.Ask "What time is it?" false
```

`Ask` can take longer than gdbus's default 25 s timeout when the model uses
tools; pass `--timeout`.

## For the NixOS unit

- `ExecStart = .../bin/duet-assistant`; drop `MemoryDenyWriteExecute=true`
  (SpiderMonkey and V8 JIT need writable+executable memory).
- Keep `LoadCredential=llm-key:...`, `StateDirectory=duet-assistant`, `TZ`.
- Put the package in `environment.systemPackages` so GNOME Shell finds
  `org.balaur.Assistant.desktop` (needed for its notifications) and the
  GSettings schema is compiled into the system profile; defaults go in a
  gschema override.
- `RestrictAddressFamilies` must keep `AF_UNIX` (D-Bus, PipeWire, the agent's pipes).
