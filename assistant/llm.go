package main

// Client for any OpenAI-compatible /chat/completions endpoint with function
// calling (OpenAI, OpenRouter, Groq, Mistral, a local llama.cpp/Ollama/vLLM, ...).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type toolSpec struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

type LLM struct {
	BaseURL     string
	Model       string
	Key         string
	Temperature *float64
	http        *http.Client
}

func newLLM(baseURL, model, key string, temperature *float64) *LLM {
	return &LLM{
		BaseURL:     strings.TrimRight(baseURL, "/"),
		Model:       model,
		Key:         key,
		Temperature: temperature,
		http:        &http.Client{Timeout: 90 * time.Second},
	}
}

func (l *LLM) chat(ctx context.Context, msgs []Message, tools []toolSpec) (Message, error) {
	body := map[string]any{"model": l.Model, "messages": msgs}
	if len(tools) > 0 {
		body["tools"] = tools
		body["tool_choice"] = "auto"
	}
	if l.Temperature != nil {
		body["temperature"] = *l.Temperature
	}
	b, err := json.Marshal(body)
	if err != nil {
		return Message{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", l.BaseURL+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return Message{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if l.Key != "" {
		req.Header.Set("Authorization", "Bearer "+l.Key)
	}
	resp, err := l.http.Do(req)
	if err != nil {
		return Message{}, err
	}
	defer resp.Body.Close()
	rb, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return Message{}, err
	}
	if resp.StatusCode/100 != 2 {
		return Message{}, fmt.Errorf("llm: %s: %s", resp.Status, truncate(string(rb), 300))
	}
	var out struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rb, &out); err != nil {
		return Message{}, fmt.Errorf("llm: bad response: %w", err)
	}
	if len(out.Choices) == 0 {
		return Message{}, errors.New("llm: no choices in response")
	}
	m := out.Choices[0].Message
	m.Role = "assistant"
	return m, nil
}

var (
	thinkRe = regexp.MustCompile(`(?s)<think>.*?</think>`)
	mdLink  = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)
	bareURL = regexp.MustCompile(`https?://\S+`)
)

// spoken cleans a model reply for text-to-speech: no reasoning blocks, no
// markdown emphasis, headings or bullets, no bare links.
func spoken(s string) string {
	s = thinkRe.ReplaceAllString(s, "")
	s = mdLink.ReplaceAllString(s, "$1")
	s = bareURL.ReplaceAllString(s, "")
	s = strings.NewReplacer("**", "", "__", "", "`", "", "#", "").Replace(s)
	var lines []string
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(ln)
		ln = strings.TrimLeft(ln, "-*• ")
		if ln != "" {
			lines = append(lines, ln)
		}
	}
	return strings.TrimSpace(strings.Join(lines, " "))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
