# Duet on GNOME: the shared contract

The Lenovo Yoga Duet 7 home server's built-in screen runs stock GNOME 50 (Shell
50.5, GJS 1.88, libadwaita 1.9, GStreamer 1.26, PipeWire) as a household tablet:
the `home` account auto-logs in, never locks, touch first (on-screen keyboard),
auto-rotation. Everything on screen is GNOME-native and every GNOME-facing piece
is written in **GJS** (ES modules, `gi://` imports, no build step beyond what
Nix packaging needs). Three pieces talk over the **session D-Bus**:

| Piece | Dir | What |
|---|---|---|
| Assistant daemon | `gnome/assistant/` | Voice assistant ("Hey Jarvis"): a `Gio.Application` running as the systemd **user** service `duet-assistant.service` in the household session. Owns `org.duet.Assistant` on the session bus. Replaces the Go one in `assistant/` (same behaviour, same config and state files). |
| Shell extension | `gnome/shell-extension/` | `duet@duet.local`: orb + captions over every app while the assistant listens/thinks/speaks/rings (tap = Stop), and a Quick Settings toggle for the microphone. |
| App | `gnome/app/` | `org.duet.Duet`, libadwaita: conversation (+ type to ask), lists, timers & reminders, memory, home services. |

## The agent: built on the pi SDK (`gnome/agent/`)

The assistant's brain (system prompt, model, tools, conversation) is
`duet-agent`, a TypeScript program built on the **pi SDK**
(`@earendil-works/pi-coding-agent` 1.4.x, https://pi.dev/docs/latest/sdk;
local copy of the docs: `$(dirname $(readlink -f $(which pi)))/../libexec/pi/docs/`,
esp. `sdk.md`, `extensions.md`, `providers.md`, `models.md`, and `../examples/sdk/`
`05-tools.ts`, `06-extensions.ts`, `12-full-control.ts`). It calls
`createAgentSession()` in its own Node process. The SDK needs Node (or Bun)
and GJS is neither, so the GJS daemon spawns `duet-agent` with
`Gio.Subprocess` and they speak **JSON lines on stdin/stdout** (stderr = logs).

- Model: Mistral through pi's provider (`MISTRAL_API_KEY` in its
  environment, from the same credential), model = config `llm.model`.
- **No built-in pi tools** (no bash/read/edit/write/grep/find/ls): a voice
  assistant fed web pages and news must not be able to run commands. Only
  our tools; check `session.getActiveToolNames()` at start-up and refuse to
  run if anything else is active.
- **No filesystem resource discovery** (no `.pi` dirs, settings files,
  skills, prompt templates, AGENTS.md/context files, MCP): everything is
  passed explicitly in code. In-memory `SessionManager`.
- Our tools, registered through the SDK (TypeBox schemas), with the same
  names, descriptions and parameters as the Go `assistant/tools.go`:
  - agent-side (Node `fetch`): weather (Open-Meteo), news (RSS feeds from
    the config), web search (Mistral's web_search, as the Go code does);
  - daemon-side (the GJS daemon owns the state and GNOME): timers,
    reminders, lists, memory, volume, time. The agent forwards these as
    `tool_call` records and awaits the matching `tool_result`.
- Conversation: one session kept across turns (follow-ups work), reset after
  the Go code's quiet period; the system prompt is rebuilt per turn from the
  `context` the daemon sends, as `assistant/assistant.go` builds it today.

Protocol (one JSON object per line; `id` correlates):

```
agent  → daemon {"type":"ready","tools":["timer_start", ...]}            (once, after start-up)
daemon → agent  {"type":"prompt","id":"p1","text":"...","lang":"ro","context":{...}}
agent  → daemon {"type":"tool_call","id":"c1","prompt":"p1","name":"timer_start","args":{...}}
daemon → agent  {"type":"tool_result","id":"c1","ok":true,"result":"..."}   (or "ok":false,"error":"...")
agent  → daemon {"type":"reply","id":"p1","text":"...","lang":"ro"}        (or {"type":"error","id":"p1","message":"..."})
daemon → agent  {"type":"abort","id":"p1"}   |   {"type":"reset"}
```

Packaging: `pkgs/duet-agent.nix` with `buildNpmPackage` (committed
`package-lock.json`, pinned `npmDepsHash`), Node 22 from nixpkgs, producing
`bin/duet-agent`; the daemon finds it via `DUET_AGENT` (set by its wrapper).

## Settings: model, server, API key

Editable in the app (Preferences on the Assistant page), GNOME-native:

- **GSettings** schema `org.duet.Assistant` (path `/org/duet/assistant/`),
  shipped by the daemon package. Keys:
  `llm-provider` (s, a pi provider id, default `mistral`), `llm-model` (s),
  `llm-base-url` (s, "" = the provider's default; for OpenAI-compatible
  servers), `speech-base-url` (s, Mistral, default `https://api.mistral.ai/v1`),
  `stt-model` (s), `tts-model` (s), `voice-ro` (s), `voice-en` (s).
  NixOS sets the defaults from `duet.assistant.*` with a gschema override
  (integrator's job); user changes live in dconf. The daemon watches
  `changed::` and applies new values without a restart (it restarts the
  agent child when an LLM key changes).
- **API keys** in the GNOME Keyring via libsecret: schema
  `org.duet.Assistant.ApiKey`, attribute `provider` (`mistral`, `openai`, ...).
  Only the daemon reads them. Fallback when the keyring has none for
  `mistral`: the credential file (`$CREDENTIALS_DIRECTORY/llm-key`), as today.
  The household account has no password, so the first store makes GNOME ask
  for a keyring password (the user leaves it empty); don't try to work around that.
- Speech (Voxtral STT/TTS) always uses the `mistral` key and `speech-base-url`;
  the chat model may use any pi provider with its own key.

D-Bus additions on `org.duet.Assistant1` (same object):

```xml
<!-- pi's catalog for the model picker: {"providers":[{"id":"mistral","name":"Mistral",
     "models":[{"id":"mistral-medium-latest","name":"..."}]}, ...]} -->
<property name="Models" type="s" access="read"/>
<!-- Which providers have a key stored (never the key itself): {"mistral": true, ...} -->
<property name="ApiKeys" type="s" access="read"/>
<method name="SetApiKey"><arg name="provider" type="s" direction="in"/><arg name="key" type="s" direction="in"/></method>  <!-- "" deletes -->
<!-- One tiny request with the current settings: "" when fine, else the human error. -->
<method name="TestModel"><arg name="error" type="s" direction="out"/></method>
```

The agent reports pi's model catalog in its `ready` record (`"models": {...}`
in the same shape) so the daemon can publish `Models`.

## D-Bus API: `org.duet.Assistant`

- Bus name `org.duet.Assistant`, object `/org/duet/Assistant`, interface `org.duet.Assistant1`.
- The daemon is a `Gio.Application` with application id `org.duet.Assistant`
  (so its desktop file `org.duet.Assistant.desktop`, `NoDisplay=true`, lets it
  send GNOME notifications). Exports the interface on the bus connection it
  gets in `vfunc_dbus_register` at the path above.

```xml
<node>
  <interface name="org.duet.Assistant1">
    <!-- idle | listening | thinking | speaking | ringing | muted -->
    <property name="State" type="s" access="read"/>
    <!-- What to show under the orb now: what it heard while thinking, the reply
         while speaking, the alarm text while ringing; "" otherwise. -->
    <property name="Caption" type="s" access="read"/>
    <!-- Microphone off: no capture at all (GNOME's mic indicator goes away). -->
    <property name="Muted" type="b" access="readwrite"/>
    <!-- Speaker volume 0-100: the session's default sink, kept in step with GNOME. -->
    <property name="Volume" type="u" access="readwrite"/>
    <property name="Name" type="s" access="read"/>       <!-- "Jarvis" -->
    <property name="WakeWord" type="s" access="read"/>   <!-- "hey_jarvis" -->
    <property name="Error" type="s" access="read"/>      <!-- last error, "" when fine -->
    <!-- Everything else, as one JSON document (shape below). Changes are
         announced with PropertiesChanged like the others. -->
    <property name="Snapshot" type="s" access="read"/>

    <method name="Ask">        <!-- typed question; same pipeline as speech -->
      <arg name="text" type="s" direction="in"/>
      <arg name="speak" type="b" direction="in"/>
      <arg name="reply" type="s" direction="out"/>
    </method>
    <method name="Stop"/>      <!-- stop listening/speaking/ringing now -->
    <method name="ListAdd">     <arg name="list" type="s" direction="in"/><arg name="text" type="s" direction="in"/></method>
    <method name="ListSetDone"> <arg name="list" type="s" direction="in"/><arg name="id" type="s" direction="in"/><arg name="done" type="b" direction="in"/></method>
    <method name="ListRemove">  <arg name="list" type="s" direction="in"/><arg name="id" type="s" direction="in"/></method>
    <method name="ListClearDone"><arg name="list" type="s" direction="in"/></method>
    <method name="MemoryAdd">   <arg name="fact" type="s" direction="in"/></method>
    <method name="MemoryRemove"><arg name="id" type="s" direction="in"/></method>
    <method name="TimerCancel"> <arg name="id" type="s" direction="in"/></method>
    <method name="ReminderCancel"><arg name="id" type="s" direction="in"/></method>
  </interface>
</node>
```

Errors: methods fail with a D-Bus error `org.duet.Assistant.Error.Failed` (message = human text).

### `Snapshot` JSON

The same shape the Go service's `GET /status` returns today (see
`assistant/assistant.go` `Status`, `assistant/store.go`), so nothing is lost:

```json
{
  "log": [{"at": "2026-11-04T16:13:20+02:00", "heard": "...", "reply": "...", "lang": "ro"}],
  "timers": [{"id": "t1", "label": "pasta", "ends": "2026-11-04T16:30:00+02:00"}],
  "reminders": [{"id": "...", "text": "...", "at": "..."}],
  "lists": {"shopping": [{"id": "...", "text": "milk", "done": false}], "tasks": []},
  "listOrder": ["shopping", "tasks"],
  "memories": [{"id": "...", "fact": "..."}]
}
```

Field names follow the Go structs' JSON tags exactly (check them; the example
above is indicative). Times are RFC 3339 with offset.

### Notifications (sent by the daemon)

Timers and reminders going off are GNOME notifications from
`org.duet.Assistant` (`Gio.Notification`, priority `URGENT` for alarms) with a
**Stop** button (app action `app.stop`) besides the spoken alarm.

## Runtime facts (this machine)

- Microphone: PipeWire source node **`duet-mic`** (the array's 16 kHz device,
  S16LE stereo); downmix to 16 kHz mono S16LE. It is the default source.
  Capture with GStreamer: `pipewiresrc target-object=duet-mic ! audioconvert !
  audioresample ! audio/x-raw,format=S16LE,rate=16000,channels=1 ! appsink`.
  Speak through the default sink (`appsrc ! audioconvert ! audioresample !
  pipewiresink`), stream property `media.role=Assistant`.
- Wake word: openWakeWord's Wyoming server at `tcp://127.0.0.1:10400`
  (protocol: see `assistant/wyoming.go`), 80 ms chunks (1280 samples).
- Config: JSON file at `$DUET_ASSISTANT_CONFIG` (same schema as the Go
  `Config` in `assistant/assistant.go`; Nix writes it in `modules/assistant.nix`).
- API key: `$CREDENTIALS_DIRECTORY/llm-key` (systemd LoadCredential), fallback
  `$DUET_ASSISTANT_LLM_KEY`.
- State: `$STATE_DIRECTORY` (= `~/.local/state/duet-assistant`), file
  `house.json`. **Keep the Go format byte-compatible**: the household's lists
  and memories live there.
- Timezone: `$TZ` (Europe/Bucharest).
- Volume: `wpctl get-volume/set-volume @DEFAULT_AUDIO_SINK@` (or `pactl`).
- Home services for the app: `/etc/duet/services.json`, an array of
  `{name, description, icon, url, unit, desktopId}` (`unit` = systemd system
  unit, or `user:<unit>` for a unit of the user session; `desktopId` = the
  GNOME app to launch for it, may be null; `url` may be null).
- Testing on this box: the Go assistant is the live one; don't stop it. You
  may run your piece by hand as the household user, e.g.
  `sudo -u home env XDG_RUNTIME_DIR=/run/user/1002 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1002/bus <cmd>`
  (passwordless sudo is on for development). Never `nixos-rebuild`; the
  integrator does that. Tools: `nix shell nixpkgs#gjs nixpkgs#libadwaita ...`.
- Nixpkgs for packaging: the flake's input, e.g.
  `nix build --impure --expr 'let p = (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux; in p.callPackage ./pkgs/<file>.nix {}'`.

## Style (house rules)

Plain, well-commented code that explains *why*; no frameworks beyond GNOME's
own libraries; small files by concern. Comments and UI strings in English;
the assistant speaks Romanian and English as today.
