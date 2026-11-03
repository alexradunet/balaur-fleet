package main

// The voice pipeline. One goroutine (run) does one thing at a time:
//
//	wake word ─► listen (VAD) ─► transcribe ─► think (LLM + tools) ─► speak ─┐
//	    ▲                                                                    │
//	    └──────────────── follow-up when the reply was a question ◄──────────┘
//
// Typed requests from the dashboard and ringing timers/reminders go through
// the same goroutine. Saying the wake word interrupts whatever is going on
// (speech, a ringing timer, a slow answer) and starts listening again.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Config struct {
	Listen      string `json:"listen"`
	Name        string `json:"name"`
	DefaultLang string `json:"defaultLanguage"`
	Audio       struct {
		Input  string `json:"input"`
		Output string `json:"output"`
		Card   string `json:"card"`
		Volume int    `json:"volume"`
	} `json:"audio"`
	Wake struct {
		URI   string   `json:"uri"`
		Words []string `json:"words"`
	} `json:"wake"`
	// Speech, voices and web search all use the LLM's Mistral endpoint and key.
	STT struct {
		Model string `json:"model"`
	} `json:"stt"`
	TTS struct {
		Model  string            `json:"model"`
		Voices map[string]string `json:"voices"` // "ro", "en" -> voice id; "" = default
	} `json:"tts"`
	Search struct {
		Model string `json:"model"` // for Mistral's web_search tool; "" = off
	} `json:"search"`
	LLM struct {
		BaseURL     string   `json:"baseUrl"`
		Model       string   `json:"model"`
		Temperature *float64 `json:"temperature"`
	} `json:"llm"`
	Location  Location `json:"location"`
	NewsFeeds []Feed   `json:"newsFeeds"`
}

type Exchange struct {
	At    time.Time `json:"at"`
	Heard string    `json:"heard"`
	Reply string    `json:"reply"`
	Typed bool      `json:"typed"`
	Lang  string    `json:"lang"`
}

type alarm struct {
	kind string // "timer" or "reminder"
	text string
	lang string
}

type textReq struct {
	text  string
	speak bool
	resp  chan textResp
}

type textResp struct {
	reply string
	err   error
}

type Assistant struct {
	cfg     Config
	store   *Store
	llm     *LLM
	mistral *Mistral
	web     *webTools
	timers  *timers
	tools   []Tool
	specs   []toolSpec
	mic     *Mic
	player  *Player
	floor   noiseFloor

	recording atomic.Bool
	recFrames chan []byte
	wakeCh    chan struct{}
	textCh    chan textReq
	alarmCh   chan alarm

	history []Message // touched only by the run goroutine
	histAt  time.Time

	mu        sync.Mutex
	state     string
	lastErr   string
	lastLang  string
	log       []Exchange
	volume    int
	cancelCur context.CancelFunc
	changed   chan struct{} // closed and replaced on every state change (long-poll)
}

func newAssistant(cfg Config, store *Store, llm *LLM) *Assistant {
	a := &Assistant{
		mistral:   newMistral(llm.BaseURL, llm.Key),
		cfg:       cfg,
		store:     store,
		llm:       llm,
		web:       newWebTools(cfg.Location, cfg.NewsFeeds),
		mic:       newMic(cfg.Audio.Input),
		player:    &Player{device: cfg.Audio.Output},
		recFrames: make(chan []byte, 256),
		wakeCh:    make(chan struct{}, 1),
		textCh:    make(chan textReq),
		alarmCh:   make(chan alarm, 16),
		state:     "idle",
		lastLang:  cfg.DefaultLang,
		volume:    cfg.Audio.Volume,
		changed:   make(chan struct{}),
	}
	a.timers = newTimers(func(t *Timer) {
		a.alarmCh <- alarm{kind: "timer", text: t.Label, lang: t.Lang}
		a.notify()
	})
	a.tools = a.buildTools()
	a.specs = toolSpecs(a.tools)
	store.onChange = a.notify
	return a
}

func (a *Assistant) notify() {
	a.mu.Lock()
	close(a.changed)
	a.changed = make(chan struct{})
	a.mu.Unlock()
}

func (a *Assistant) setState(s string) {
	a.mu.Lock()
	changed := a.state != s
	a.state = s
	a.mu.Unlock()
	if changed {
		a.notify()
	}
}

func (a *Assistant) setError(err error) {
	a.mu.Lock()
	if err == nil {
		a.lastErr = ""
	} else {
		a.lastErr = err.Error()
	}
	a.mu.Unlock()
}

func (a *Assistant) Volume() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.volume
}

func (a *Assistant) SetVolume(ctx context.Context, v int) error {
	v = max(0, min(100, v))
	if err := setVolume(ctx, a.cfg.Audio.Card, v); err != nil {
		return err
	}
	a.mu.Lock()
	a.volume = v
	a.mu.Unlock()
	a.notify()
	return nil
}

// begin starts an interruptible piece of work (listening, speaking, ringing).
func (a *Assistant) begin(ctx context.Context) context.Context {
	ictx, cancel := context.WithCancel(ctx)
	a.mu.Lock()
	a.cancelCur = cancel
	a.mu.Unlock()
	return ictx
}

func (a *Assistant) end() {
	a.mu.Lock()
	if a.cancelCur != nil {
		a.cancelCur()
		a.cancelCur = nil
	}
	a.mu.Unlock()
	a.setState("idle")
}

// Stop interrupts whatever is going on (speech, ringing, listening).
func (a *Assistant) Stop() {
	a.mu.Lock()
	if a.cancelCur != nil {
		a.cancelCur()
	}
	a.mu.Unlock()
}

func (a *Assistant) SetMuted(m bool) {
	a.mic.SetMuted(m)
	if m {
		a.Stop()
	}
	a.notify()
}

// ---- microphone routing + wake word ----

// route sends each mic frame either to the recorder (while listening) or to
// the wake word server (the rest of the time, including while speaking).
func (a *Assistant) route(ctx context.Context) {
	var ws *wakeStream
	var retryAt time.Time
	defer func() {
		if ws != nil {
			ws.close()
		}
	}()
	for {
		var f []byte
		select {
		case f = <-a.mic.Frames:
		case <-ctx.Done():
			return
		}
		if a.recording.Load() {
			// The wake word server keeps a window of recent audio: resuming the
			// same stream after listening would find the old wake word again.
			if ws != nil {
				ws.close()
				ws = nil
			}
			select {
			case a.recFrames <- f:
			default:
			}
			continue
		}
		a.mu.Lock()
		idle := a.state == "idle"
		a.mu.Unlock()
		if idle {
			a.floor.update(frameRMS(f))
		}
		if ws == nil {
			if time.Now().Before(retryAt) {
				continue
			}
			var err error
			ws, err = openWakeStream(ctx, a.cfg.Wake.URI, a.cfg.Wake.Words)
			if err != nil {
				log.Printf("wake word server: %v", err)
				retryAt = time.Now().Add(3 * time.Second)
				ws = nil
				continue
			}
			go func(hits <-chan string) {
				for name := range hits {
					log.Printf("wake word: %s", name)
					a.onWake()
				}
			}(ws.hits)
		}
		if err := ws.feed(f); err != nil {
			log.Printf("wake word server: %v", err)
			ws.close()
			ws = nil
		}
	}
}

func (a *Assistant) onWake() {
	a.Stop()
	select {
	case a.wakeCh <- struct{}{}:
	default:
	}
}

// ---- the main loop ----

func (a *Assistant) run(ctx context.Context) {
	go a.mic.Run(ctx)
	go a.route(ctx)
	go a.reminderLoop(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.wakeCh:
			a.voiceTurn(ctx)
		case req := <-a.textCh:
			reply, err := a.textTurn(ctx, req)
			req.resp <- textResp{reply, err}
		case al := <-a.alarmCh:
			a.ring(ctx, al)
		}
	}
}

func (a *Assistant) reminderLoop(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			for _, r := range a.store.TakeDue(now) {
				a.alarmCh <- alarm{kind: "reminder", text: r.Text, lang: r.Lang}
			}
		}
	}
}

// Ask submits a typed request and waits for the answer.
func (a *Assistant) Ask(ctx context.Context, text string, speak bool) (string, error) {
	req := textReq{text: text, speak: speak, resp: make(chan textResp, 1)}
	select {
	case a.textCh <- req:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	select {
	case r := <-req.resp:
		return r.reply, r.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (a *Assistant) voiceTurn(ctx context.Context) {
	ictx := a.begin(ctx)
	defer a.end()
	for followUps := 0; followUps < 3 && ictx.Err() == nil; followUps++ {
		a.setState("listening")
		if followUps == 0 {
			_ = a.player.PlayPCM(ictx, earconListen)
		}
		// Drop frames from before (and during) the earcon, then record.
		for len(a.recFrames) > 0 {
			<-a.recFrames
		}
		a.recording.Store(true)
		vcfg := defaultVAD
		if followUps > 0 {
			vcfg.StartTimeout = 4 * time.Second
		}
		pcm, heard, peak, th := recordUtterance(ictx, a.recFrames, &a.floor, vcfg)
		a.recording.Store(false)
		log.Printf("listened: speech %v (peak level %.0f, threshold %.0f)", heard, peak, th)
		if !heard {
			if ictx.Err() == nil && followUps == 0 {
				_ = a.player.PlayPCM(ictx, earconDone)
			}
			return
		}

		a.setState("thinking")
		start := time.Now()
		tr, err := a.mistral.Transcribe(ictx, a.cfg.STT.Model, pcm, "")
		if err != nil {
			a.fail(ictx, "speech-to-text", err)
			return
		}
		log.Printf("heard (%s, %.1fs): %q", tr.Language, time.Since(start).Seconds(), tr.Text)
		// Language detection on a second of audio is shaky ("Cât e ceasul?" came
		// out as Turkish): if it is neither Romanian nor English, ask again in
		// the language of the conversation.
		if !looksRoOrEn(tr.Text) {
			a.mu.Lock()
			lang := a.lastLang
			a.mu.Unlock()
			if tr2, err := a.mistral.Transcribe(ictx, a.cfg.STT.Model, pcm, lang); err == nil {
				log.Printf("heard again as %s (%.1fs): %q", lang, time.Since(start).Seconds(), tr2.Text)
				tr = Transcript{Text: tr2.Text, Language: lang}
			}
		}
		text := tr.Text
		if isNoise(text) {
			return
		}
		if isStop(text) {
			_ = a.player.PlayPCM(ictx, earconDone)
			return
		}
		lang := a.pickLang(normLang(tr.Language), text)
		reply, err := a.converse(ictx, text, &turn{lang: lang})
		if err != nil {
			a.fail(ictx, "assistant", err)
			return
		}
		a.record(Exchange{At: time.Now(), Heard: text, Reply: reply, Lang: lang})
		log.Printf("reply (%.1fs): %q", time.Since(start).Seconds(), reply)
		if err := a.speak(ictx, reply, lang); err != nil {
			return
		}
		// Only keep listening without the wake word if the assistant asked something.
		if !strings.HasSuffix(strings.TrimSpace(reply), "?") {
			return
		}
	}
}

func (a *Assistant) textTurn(ctx context.Context, req textReq) (string, error) {
	a.setState("thinking")
	defer a.setState("idle")
	lang := a.pickLang("", req.text)
	reply, err := a.converse(ctx, req.text, &turn{lang: lang, typed: true})
	if err != nil {
		a.setError(err)
		return "", err
	}
	a.record(Exchange{At: time.Now(), Heard: req.text, Reply: reply, Typed: true, Lang: lang})
	if req.speak {
		ictx := a.begin(ctx)
		_ = a.speak(ictx, reply, lang)
		a.end()
	}
	return reply, nil
}

func (a *Assistant) pickLang(reported, text string) string {
	lang := reported
	if l := detectLang(text); l != "" && (lang == "" || lang != "ro" && lang != "en") {
		lang = l
	}
	if lang != "ro" && lang != "en" {
		a.mu.Lock()
		lang = a.lastLang
		a.mu.Unlock()
	}
	a.mu.Lock()
	a.lastLang = lang
	a.mu.Unlock()
	return lang
}

func (a *Assistant) record(e Exchange) {
	a.mu.Lock()
	a.log = append(a.log, e)
	if len(a.log) > 20 {
		a.log = a.log[len(a.log)-20:]
	}
	a.lastErr = ""
	a.mu.Unlock()
	a.notify()
}

func (a *Assistant) fail(ctx context.Context, what string, err error) {
	if ctx.Err() != nil {
		return // interrupted, not an error
	}
	log.Printf("%s: %v", what, err)
	a.setError(fmt.Errorf("%s: %w", what, err))
	a.notify()
	_ = a.player.PlayPCM(ctx, earconError)
}

// Whisper "hears" these in silence and noise.
var noisePhrases = []string{
	"thank you for watching", "thanks for watching", "subtitles by", "mulțumesc pentru vizionare",
	"multumesc pentru vizionare", "abonați-vă", "abonati-va", "vă mulțumesc pentru vizionare",
}

func isNoise(text string) bool {
	t := fold(strings.Trim(text, " .,!?…"))
	if len([]rune(t)) < 2 {
		return true
	}
	for _, p := range noisePhrases {
		if strings.Contains(t, fold(p)) {
			return true
		}
	}
	return false
}

var stopWords = toSet("stop gata lasa nimic anuleaza taci cancel nevermind never mind nothing quiet ok okay bine mersi multumesc thanks")

func isStop(text string) bool {
	t := strings.Join(strings.Fields(fold(strings.Trim(text, " .,!?…"))), " ")
	return stopWords[t] || t == "never mind" || t == "lasa asta" || t == "nu mai conteaza"
}

// ---- thinking ----

func (a *Assistant) systemPrompt(t *turn) string {
	now := time.Now()
	var b strings.Builder
	fmt.Fprintf(&b, "You are %s, the private voice assistant of a home", a.cfg.Name)
	if a.cfg.Location.Name != "" {
		fmt.Fprintf(&b, " in %s", a.cfg.Location.Name)
	}
	fmt.Fprintf(&b, ". You run on a small home server and talk through its speaker.\n")
	fmt.Fprintf(&b, "Today is %s. The local time is %s (24-hour clock, %s).\n\n", now.Format("Monday, 2 January 2006"), now.Format("15:04"), now.Location())
	b.WriteString(`Rules:
- Answer in the language of the user's last message: Romanian (always with correct diacritics: ă â î ș ț) or English.
- Your words are spoken aloud: 1 to 3 short sentences, no markdown, lists, symbols, emojis or links.
- Write numbers with digits; the voice reads them. Times: in Romanian "ora 23 și 2 minute" (never "23:02"), in English "11:02 PM".
- Use tools to act: timers, reminders, house lists (shopping, tasks), memory, weather, news, web search, volume. Never claim you did something without calling the tool.
- When the user shares a lasting fact or preference about themselves or the household (names, birthdays, allergies, diet, routines, likes), save it with remember. Do not save one-off requests or small talk.
- Things to buy go on the "shopping" list; chores and household to-dos go on "tasks", unless the user names another list.
- For current events, facts that change, prices or anything you are unsure of, use web_search or news. If you cannot find it, say so briefly.
- If a request is ambiguous, ask one short question.
`)
	if t.lang == "en" {
		b.WriteString("- The user is speaking English now: reply in English.\n")
	} else if t.lang == "ro" {
		b.WriteString("- The user is speaking Romanian now: reply in Romanian.\n")
	}
	if t.typed {
		b.WriteString("- This message was typed on the dashboard, not spoken; the reply is shown as text and may be a little longer, still plain text.\n")
	}
	mems := a.store.Memories()
	if len(mems) > 0 {
		b.WriteString("\nWhat you know about this household (id in brackets, for forget):\n")
		for _, m := range mems {
			fmt.Fprintf(&b, "- [%s] %s\n", m.ID, m.Fact)
		}
	}
	return b.String()
}

const (
	historyTTL   = 5 * time.Minute
	historyMax   = 24
	maxToolRound = 6
)

func (a *Assistant) converse(ctx context.Context, text string, t *turn) (string, error) {
	if time.Since(a.histAt) > historyTTL {
		a.history = nil
	}
	msgs := append([]Message{{Role: "system", Content: a.systemPrompt(t)}}, a.history...)
	msgs = append(msgs, Message{Role: "user", Content: text})

	reply := ""
	for round := 0; round < maxToolRound; round++ {
		tools := a.specs
		if round == maxToolRound-1 {
			tools = nil // last round: make it answer
		}
		m, err := a.llm.chat(ctx, msgs, tools)
		if err != nil {
			return "", err
		}
		msgs = append(msgs, m)
		if len(m.ToolCalls) == 0 {
			reply = spoken(m.Content)
			break
		}
		for _, call := range m.ToolCalls {
			result := a.runTool(ctx, t, call)
			msgs = append(msgs, Message{Role: "tool", ToolCallID: call.ID, Content: result})
		}
	}
	if reply == "" {
		return "", errors.New("the model gave no answer")
	}

	// Keep the conversation (without the system prompt), starting at a user message.
	h := msgs[1:]
	if len(h) > historyMax {
		h = h[len(h)-historyMax:]
		for len(h) > 0 && h[0].Role != "user" {
			h = h[1:]
		}
	}
	a.history, a.histAt = h, time.Now()
	return reply, nil
}

func (a *Assistant) runTool(ctx context.Context, t *turn, call ToolCall) string {
	name := call.Function.Name
	for _, tool := range a.tools {
		if tool.Name != name {
			continue
		}
		tctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		res, err := tool.Run(tctx, t, json.RawMessage(call.Function.Arguments))
		if err != nil {
			log.Printf("tool %s(%s): %v", name, call.Function.Arguments, err)
			return fmt.Sprintf(`{"error": %q}`, err.Error())
		}
		log.Printf("tool %s(%s)", name, call.Function.Arguments)
		b, err := json.Marshal(res)
		if err != nil {
			return fmt.Sprintf(`{"error": %q}`, err.Error())
		}
		return string(b)
	}
	return fmt.Sprintf(`{"error": "unknown tool %q"}`, name)
}

// ---- speaking ----

// sentences splits text so the first sentence can play while the rest is synthesised.
func sentences(text string) []string {
	var out []string
	start := 0
	rs := []rune(text)
	for i, r := range rs {
		if (r == '.' || r == '!' || r == '?' || r == '…') && (i+1 == len(rs) || rs[i+1] == ' ') {
			if s := strings.TrimSpace(string(rs[start : i+1])); s != "" {
				out = append(out, s)
			}
			start = i + 1
		}
	}
	if s := strings.TrimSpace(string(rs[start:])); s != "" {
		out = append(out, s)
	}
	return out
}

// voiceFor picks the configured voice for the reply's language ("" = the API's default).
func (a *Assistant) voiceFor(text, lang string) string {
	if l := detectLang(text); l != "" {
		lang = l
	}
	if v, ok := a.cfg.TTS.Voices[lang]; ok {
		return v
	}
	return a.cfg.TTS.Voices[a.cfg.DefaultLang]
}

// speak synthesises sentence by sentence, so the first one plays while the
// next is being made.
func (a *Assistant) speak(ctx context.Context, text, lang string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	a.setState("speaking")
	voice := a.voiceFor(text, lang)
	ch := make(chan PCM, 4)
	synthErr := make(chan error, 1)
	go func() {
		defer close(ch)
		for _, s := range sentences(text) {
			t0 := time.Now()
			p, err := a.mistral.Speak(ctx, a.cfg.TTS.Model, voice, s)
			log.Printf("voice: %d chars in %.1fs", len([]rune(s)), time.Since(t0).Seconds())
			if err != nil {
				synthErr <- err
				return
			}
			select {
			case ch <- p:
			case <-ctx.Done():
				synthErr <- ctx.Err()
				return
			}
		}
		synthErr <- nil
	}()
	err := a.player.Play(ctx, ch)
	for range ch { // let the producer finish if playback stopped early
	}
	if serr := <-synthErr; serr != nil && ctx.Err() == nil {
		a.fail(ctx, "text-to-speech", serr)
		return serr
	}
	if err != nil && ctx.Err() == nil {
		log.Printf("playback: %v", err)
		a.setError(fmt.Errorf("playback: %w", err))
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func alarmText(al alarm) string {
	ro := al.lang == "ro"
	switch {
	case al.kind == "reminder" && ro:
		return "Îți amintesc: " + al.text
	case al.kind == "reminder":
		return "Reminder: " + al.text
	case al.text != "" && ro:
		return "Timpul a expirat pentru " + al.text + "."
	case al.text != "":
		return "Your " + al.text + " timer is done."
	case ro:
		return "Timpul a expirat."
	}
	return "Time's up."
}

// ring plays an alarm until the wake word, the dashboard's stop button, or
// a few repetitions.
func (a *Assistant) ring(ctx context.Context, al alarm) {
	ictx := a.begin(ctx)
	defer a.end()
	a.setState("ringing")
	a.record(Exchange{At: time.Now(), Reply: alarmText(al), Lang: al.lang})
	repeats := 5
	if al.kind == "reminder" {
		repeats = 2
	}
	for i := 0; i < repeats && ictx.Err() == nil; i++ {
		a.setState("ringing")
		if err := a.player.PlayPCM(ictx, earconAlarm); err != nil && ictx.Err() == nil {
			log.Printf("alarm: %v", err)
		}
		_ = a.speak(ictx, alarmText(al), al.lang)
		select {
		case <-time.After(3 * time.Second):
		case <-ictx.Done():
		}
	}
}

// ---- status for the dashboard ----

type Status struct {
	Name      string                 `json:"name"`
	State     string                 `json:"state"`
	Muted     bool                   `json:"muted"`
	Volume    int                    `json:"volume"`
	WakeWord  string                 `json:"wakeWord"`
	Model     string                 `json:"model"`
	Error     string                 `json:"error,omitempty"`
	Log       []Exchange             `json:"log"`
	Timers    []map[string]any       `json:"timers"`
	Reminders []Reminder             `json:"reminders"`
	Lists     map[string][]HouseItem `json:"lists"`
	ListOrder []string               `json:"listOrder"`
	Memories  []Memory               `json:"memories"`
}

func (a *Assistant) Status() Status {
	a.mu.Lock()
	st := Status{
		Name: a.cfg.Name, State: a.state, Volume: a.volume, Error: a.lastErr,
		Model: a.cfg.LLM.Model, Log: append([]Exchange{}, a.log...),
	}
	a.mu.Unlock()
	st.Muted = a.mic.Muted()
	st.WakeWord = strings.Join(a.cfg.Wake.Words, ", ")
	st.Timers = a.timers.list()
	st.Reminders = a.store.Reminders()
	if st.Reminders == nil {
		st.Reminders = []Reminder{}
	}
	st.Lists = a.store.Lists()
	st.ListOrder = a.store.ListNames()
	st.Memories = a.store.Memories()
	if st.Memories == nil {
		st.Memories = []Memory{}
	}
	return st
}

// Changed returns a channel that closes at the next state change.
func (a *Assistant) Changed() <-chan struct{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.changed
}
