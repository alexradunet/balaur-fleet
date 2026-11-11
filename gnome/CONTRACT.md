# Balaur on GNOME: the shared contract

The Lenovo Yoga Duet 7 home server's built-in screen runs stock GNOME 50 (Shell
50.5, GJS 1.88, libadwaita 1.9, GStreamer 1.26, PipeWire) as a household tablet:
the `home` account auto-logs in, never locks, touch first (on-screen keyboard),
auto-rotation. Everything on screen is GNOME-native and every GNOME-facing piece
is written in **GJS** (ES modules, `gi://` imports, no build step beyond what
Nix packaging needs). Three pieces talk over the **session D-Bus**:

| Piece | Dir | What |
|---|---|---|
| Assistant daemon | `gnome/assistant/` | Voice assistant ("Hey Jarvis"): a `Gio.Application` running as the systemd **user** service `balaur-assistant.service` in the household session. Owns `org.balaur.Assistant` on the session bus. (It replaced a Go service; its state files keep that format.) |
| Shell extension | `gnome/shell-extension/` | `balaur@balaur.local`: orb + captions over every app while the assistant listens/thinks/speaks/rings (tap = Stop), a Quick Settings toggle for the microphone and a "Scenes" menu (Home Assistant), and the ambient screen when idle (reads `Snapshot` for timers and reminders). |
| App | `gnome/app/` | `org.balaur.Balaur`, libadwaita: conversation (+ type to ask), lists, timers & reminders, memory, home services; the overview's search provider. |

## The agent: the fleet's pi in its home role (`gnome/home-agent/`)

The assistant's brain (system prompt, model, tools, conversation) is the
installed **pi** (https://pi.dev, the one `modules/agent.nix` gives every
machine), in a role of its own: the home role. The GJS daemon starts the
launcher `balaur-home-agent` (`$BALAUR_AGENT`, set by its wrapper) with
`Gio.Subprocess`. The launcher runs `pi --mode rpc` with one extension,
`gnome/home-agent/index.ts`, and nothing else. pi's docs are in
`$(dirname $(readlink -f $(which pi)))/../libexec/pi/docs/` (`rpc.md`,
`rpc-commands.md`, `extensions.md`, `models.md`).

- Model: the fleet's AI entryway (`modules/ai.nix`) as pi's provider `balaur`,
  from the `models.json` the `agent` aspect makes (`$BALAUR_PI_MODELS`), model =
  config `llm.model`. Without that aspect: pi's own Mistral provider with
  `MISTRAL_API_KEY`.
- **No tool of pi's own** (no bash/read/edit/write/grep/find/ls): a voice
  assistant fed web pages and news must not be able to run commands. Three
  locks: the launcher passes `--no-builtin-tools`; the extension exits when the
  model is offered any tool but ours (pi keeps its own registered, so what is
  checked is the active set); and a call to any other tool is blocked.
- **Nothing found on disk**: the launcher passes `--no-extensions` (so neither
  pi's built-in extensions nor anything in the agent directory's `extensions/`
  load: only the ones it names with `--extension`), `--no-skills`,
  `--no-prompt-templates`, `--no-context-files` (AGENTS.md) and `--no-themes`;
  no MCP servers but Home Assistant's (below), no session file, an empty working
  directory, a private agent directory under the daemon's state directory.
- **House devices**: one MCP server, Home Assistant's (`/api/mcp`), when the
  unit gives `BALAUR_HOME_ASSISTANT_URL` and a readable
  `BALAUR_HOME_ASSISTANT_TOKEN_FILE` (`balaur.assistant.homeAssistant`; the
  shared sops secret `home-assistant-agent-token`, a non-admin Home Assistant
  user for the assistant). The launcher writes pi's `mcp.json` with it:
  `exposure: direct`, no codemode, the resource tools excluded, the token read
  by the header's command. The launcher loads pi's own MCP extension
  (`--extension builtin:mcp`) for it, and only then. Its tools,
  `mcp__homeassistant__*`, are the only ones not ours the extension allows; what
  they can switch is what is exposed to Assist. Without them it runs with
  `--no-mcp`, as before.
- Our tools, registered by the extension (TypeBox schemas):
  - in the extension (Node `fetch`): weather (Open-Meteo), news (RSS feeds from
    the config), web search (Mistral's web_search);
  - daemon-side (the GJS daemon owns the state and GNOME): timers, reminders,
    lists, memory, volume. The extension calls the daemon over D-Bus
    (`AgentTool`, with `busctl`) and returns its JSON to the model.
- The system prompt is built for every question (`prompt.ts`) from the
  daemon's `AgentContext`: time, language, typed or spoken, memories.
- At most 6 model rounds per question; the last gets no tools, so it answers.
- **Text from the web is untrusted.** Once `web_search` or `news` has returned in a
  conversation, the extension refuses the tools that act, for the rest of that
  conversation: Home Assistant's (all but its two read-only ones), `remember`,
  `forget`, `add_reminder`, `delete_reminder` and `set_volume`. It tells the model
  to have the user ask again as a new request; a new conversation (`new_session`)
  starts clean. A page cannot make it switch the house or save a fact that every
  later prompt would repeat. A `remember` fact is one line of at most 200
  characters (`gnome/assistant/tools.js`), and there are at most 50.
- Conversation: one pi session kept across turns (follow-ups work), a new one
  after 5 quiet minutes (the daemon sends `new_session`).

What the daemon uses of pi's RPC protocol (`gnome/assistant/agent.js`; one JSON
object per line, `id` correlates a command with its `response`):

```
daemon → pi  {"id":"c1","type":"get_state"}  {"id":"c2","type":"get_available_models"}   (once: "ready")
daemon → pi  {"id":"p1","type":"prompt","message":"..."}
pi → daemon  {"id":"p1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
pi → daemon  {"type":"message_end","message":{"role":"assistant","content":[...],"stopReason":"stop"}}   (the last one is the answer)
pi → daemon  {"type":"agent_settled","aborted":false}
daemon → pi  {"type":"abort"}  |  {"type":"new_session"}  |  {"type":"set_model","provider":"balaur","modelId":"balaur-local"}
daemon → pi  {"id":"p0","type":"prompt","message":"/mcp reconnect homeassistant"}   (a new conversation, with house devices; the response says "handled")
```

pi connects Home Assistant once, at its start, and never retries a first connection
that failed, so the daemon asks it to before the first question of each conversation
(4 seconds at most). A child that does not answer its start-up commands, or does not
settle within 5 seconds of an `abort`, is killed and started again; one that keeps
exiting is restarted after 3 s, 6 s and so on up to 5 minutes.

Packaging: `pkgs/balaur-home-agent.nix`: the launcher and the extension's three
files, nothing to build (pi runs TypeScript). Its check runs the real pi with
the extension against a model and a daemon the test plays
(`gnome/home-agent/test/rpc.test.mjs`).

## Settings: model, API key

Editable in the app (Preferences on the Assistant page), GNOME-native:

- **GSettings** schema `org.balaur.Assistant` (path `/org/balaur/assistant/`),
  shipped by the daemon package. Keys:
  `llm-model` (s, one of the agent's models: `balaur`, `balaur-local`,
  `balaur-remote`), `speech-base-url` (s, Mistral's API; empty by default, which
  means the config file's `llm.baseUrl`), `stt-model` (s), `tts-model` (s), `voice-ro` (s),
  `voice-en` (s).
  An empty key falls back to the config file, which NixOS writes from
  `balaur.assistant.*`; a gschema override would only reach a session after the
  next login. User changes live in dconf. `Models` also carries `defaults`
  ({model}: what the empty key means), so the app shows it. The app writes a
  text key when the row is applied, not while it is typed, and takes a speech
  address only if it is https or this machine (it receives the API key). The daemon watches
  `changed::` and applies new values without a restart: a new model is set on
  the running agent (`set_model`); `speech-base-url` restarts the agent child,
  which has it in its environment for web search.
- Which machine or service answers under each model name is not chosen here:
  that is the AI entryway's page (`modules/ai.nix`).
- **The Mistral API key** in the GNOME Keyring via libsecret: schema
  `org.balaur.Assistant.ApiKey`, attribute `provider` (`mistral`).
  Only the daemon reads it. Fallback when the keyring has none: the credential
  file (`$CREDENTIALS_DIRECTORY/llm-key`, or `$BALAUR_ASSISTANT_KEY_FILE`).
  The household account has no password, so the first store makes GNOME ask
  for a keyring password (the user leaves it empty); don't try to work around that.
- Speech (Voxtral STT/TTS) and web search use the Mistral key and `speech-base-url`.

D-Bus additions on `org.balaur.Assistant1` (same object):

```xml
<!-- The agent's models for the picker: {"providers":[{"id":"balaur","name":"balaur",
     "models":[{"id":"balaur","name":"..."}, ...]}], "defaults":{"model":"balaur"}} -->
<property name="Models" type="s" access="read"/>
<!-- Whether the key is stored (never the key itself): {"mistral": true} -->
<property name="ApiKeys" type="s" access="read"/>
<method name="SetApiKey"><arg name="provider" type="s" direction="in"/><arg name="key" type="s" direction="in"/></method>  <!-- "" deletes -->
<!-- One tiny request with the current model: "" when fine, else the human error. -->
<method name="TestModel"><arg name="error" type="s" direction="out"/></method>
<!-- For pi's extension, and only while a question is being answered: the context of
     that question as JSON (name, location, date, time, zone, typed, lang, memories),
     and one of the model's daemon-side tools (arguments and result as JSON text). -->
<method name="AgentContext"><arg name="context" type="s" direction="out"/></method>
<method name="AgentTool"><arg name="name" type="s" direction="in"/><arg name="args" type="s" direction="in"/><arg name="result" type="s" direction="out"/></method>
```

The daemon asks pi for its models at start-up (`get_available_models`, kept to
the provider it runs on) and publishes them as `Models`.

## D-Bus API: `org.balaur.Assistant`

- Bus name `org.balaur.Assistant`, object `/org/balaur/Assistant`, interface `org.balaur.Assistant1`.
- The daemon is a `Gio.Application` with application id `org.balaur.Assistant`
  (so its desktop file `org.balaur.Assistant.desktop`, `NoDisplay=true`, lets it
  send GNOME notifications). Exports the interface on the bus connection it
  gets in `vfunc_dbus_register` at the path above.

```xml
<node>
  <interface name="org.balaur.Assistant1">
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
    <property name="WakeWord" type="s" access="read"/>   <!-- the configured wake words (config `wake.words`) joined with ", ": "hey_jarvis" for the default one -->
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

Errors: methods fail with a D-Bus error `org.balaur.Assistant.Error.Failed` (message = human text).

### `Snapshot` JSON

Built in `gnome/assistant/` (`assistant.js`, `store.js`):

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

The example is indicative; `store.js` is authoritative. Times are RFC 3339 with offset.

### Notifications (sent by the daemon)

Timers and reminders going off are GNOME notifications from
`org.balaur.Assistant` (`Gio.Notification`, priority `URGENT` for alarms) with a
**Stop** button (app action `app.stop`) besides the spoken alarm.

## Runtime facts (this machine)

- Microphone: PipeWire source node **`balaur-mic`** (the array's 16 kHz device,
  S16LE stereo); downmix to 16 kHz mono S16LE. It is the default source.
  Capture with GStreamer: `pipewiresrc target-object=balaur-mic ! audioconvert !
  audioresample ! audio/x-raw,format=S16LE,rate=16000,channels=1 ! appsink`.
  Speak through the default sink (`appsrc ! audioconvert ! audioresample !
  pipewiresink`), stream property `media.role=Assistant`.
- Wake word: openWakeWord's Wyoming server at `tcp://127.0.0.1:10400`
  (client: `gnome/assistant/wyoming.js`), 80 ms chunks (1280 samples).
- Config: JSON file at `$BALAUR_ASSISTANT_CONFIG` (read by
  `gnome/assistant/config.js`; Nix writes it in `modules/assistant.nix`).
- API keys: the GNOME Keyring (see Settings); fallback for Mistral the file at
  `$BALAUR_ASSISTANT_KEY_FILE` (the sops secret `assistant-llm-key`; without the
  `secrets` aspect, what `sudo balaur-assistant-login` writes), `$BALAUR_ASSISTANT_LLM_KEY` for development.
- State: `$STATE_DIRECTORY` (= `~/.local/state/balaur-assistant`), with these
  files (`store.js`): `house.json` holds the household's lists (`shopping`,
  `tasks` and any others, each a list of items), `memory.json` the remembered
  facts, `reminders.json` the reminders. They are in Go's `encoding/json`
  format (`gojson.js`), kept byte-compatible with the service it replaced. The
  daemon's own state is beside them: `timers.json` (running timers, which survive
  a restart) and `mute.json` (the microphone switch).
- Timezone: `$TZ` (Europe/Bucharest).
- Volume: `wpctl get-volume/set-volume @DEFAULT_AUDIO_SINK@` (or `pactl`).
- Home services for the app: `/etc/balaur/services.json`, an array of
  `{name, description, icon, url, unit, desktopId, group, host}` (`unit` = systemd system
  unit, or `user:<unit>` for a unit of the user session; `desktopId` = the
  GNOME app to launch for it, may be null; `url` may be null; `group` sections
  the page; `host` = null for this machine's services, else the fleet machine
  it runs on, whose web UI `url` points at its fleet `address`, the tailnet name
  (`http://tablet:8096`), with `unit` empty).
  Written on every machine by the `fleet` aspect.
- Testing on this box: the assistant is live; a second copy run by hand would
  also answer "Hey Jarvis", so keep such runs short. You may run your piece by hand as the household user, e.g.
  `sudo -u home env XDG_RUNTIME_DIR=/run/user/1002 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1002/bus <cmd>`
  (`sudo` asks for the admin's password, which an agent does not have: this is a
  step for the user). Tools: `nix shell nixpkgs#gjs nixpkgs#libadwaita ...`.
- Packaging: the packages are the flake's (`modules/flake/packages.nix`; they need
  each other, so build them by their flake name, not with `callPackage`):
  `nix build .#balaur-assistant` (also `balaur-app`, `balaur-shell-extension`,
  `balaur-home-agent`, `duet-camera`, `aminte`).

## Style (house rules)

Plain, well-commented code that explains *why*; no frameworks beyond GNOME's
own libraries; small files by concern. Comments and UI strings in English;
the assistant speaks Romanian and English as today.
