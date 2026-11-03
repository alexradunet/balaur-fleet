package main

// Outside information: weather (Open-Meteo, no key), web search (the local
// SearXNG), news (RSS/Atom feeds). Only the query leaves the house, never audio.

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type Location struct {
	Name      string  `json:"name"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type Feed struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Lang string `json:"lang"`
}

type webTools struct {
	home  Location
	feeds []Feed
	http  *http.Client

	mu        sync.Mutex
	newsCache []headline
	newsAt    time.Time
}

func newWebTools(home Location, feeds []Feed) *webTools {
	return &webTools{home: home, feeds: feeds, http: &http.Client{Timeout: 10 * time.Second}}
}

func (w *webTools) getJSON(ctx context.Context, u string, v any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := w.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("%s: %s", u, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(v)
}

// WMO weather interpretation codes, as Open-Meteo reports them.
var wmo = map[int]string{
	0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
	51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
	61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
	71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
	82: "violent showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm",
	96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}

func (w *webTools) weather(ctx context.Context, place string, days int) (any, error) {
	loc := w.home
	if place != "" && fold(place) != fold(w.home.Name) {
		var g struct {
			Results []struct {
				Name      string  `json:"name"`
				Country   string  `json:"country"`
				Latitude  float64 `json:"latitude"`
				Longitude float64 `json:"longitude"`
			} `json:"results"`
		}
		u := "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + url.QueryEscape(place)
		if err := w.getJSON(ctx, u, &g); err != nil {
			return nil, err
		}
		if len(g.Results) == 0 {
			return nil, fmt.Errorf("place %q not found", place)
		}
		r := g.Results[0]
		loc = Location{Name: r.Name + ", " + r.Country, Latitude: r.Latitude, Longitude: r.Longitude}
	}
	if loc.Latitude == 0 && loc.Longitude == 0 {
		return nil, errors.New("home location is not configured")
	}
	if days < 1 || days > 7 {
		days = 2
	}
	var f struct {
		Current struct {
			Temp     float64 `json:"temperature_2m"`
			Feels    float64 `json:"apparent_temperature"`
			Humidity float64 `json:"relative_humidity_2m"`
			Precip   float64 `json:"precipitation"`
			Code     int     `json:"weather_code"`
			Wind     float64 `json:"wind_speed_10m"`
			IsDay    int     `json:"is_day"`
		} `json:"current"`
		Daily struct {
			Time       []string  `json:"time"`
			Code       []int     `json:"weather_code"`
			Max        []float64 `json:"temperature_2m_max"`
			Min        []float64 `json:"temperature_2m_min"`
			PrecipProb []float64 `json:"precipitation_probability_max"`
			PrecipSum  []float64 `json:"precipitation_sum"`
			WindMax    []float64 `json:"wind_speed_10m_max"`
		} `json:"daily"`
	}
	u := fmt.Sprintf("https://api.open-meteo.com/v1/forecast?latitude=%f&longitude=%f&timezone=auto&forecast_days=%d"+
		"&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day"+
		"&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
		loc.Latitude, loc.Longitude, days)
	if err := w.getJSON(ctx, u, &f); err != nil {
		return nil, err
	}
	var daily []map[string]any
	for i, d := range f.Daily.Time {
		day := map[string]any{"date": d}
		if i < len(f.Daily.Code) {
			day["sky"] = wmo[f.Daily.Code[i]]
		}
		if i < len(f.Daily.Max) && i < len(f.Daily.Min) {
			day["min_c"], day["max_c"] = f.Daily.Min[i], f.Daily.Max[i]
		}
		if i < len(f.Daily.PrecipProb) {
			day["precip_chance_pct"] = f.Daily.PrecipProb[i]
		}
		if i < len(f.Daily.PrecipSum) {
			day["precip_mm"] = f.Daily.PrecipSum[i]
		}
		if i < len(f.Daily.WindMax) {
			day["wind_max_kmh"] = f.Daily.WindMax[i]
		}
		daily = append(daily, day)
	}
	return map[string]any{
		"place": loc.Name,
		"now": map[string]any{
			"temp_c": f.Current.Temp, "feels_like_c": f.Current.Feels, "humidity_pct": f.Current.Humidity,
			"sky": wmo[f.Current.Code], "precip_mm": f.Current.Precip, "wind_kmh": f.Current.Wind,
		},
		"daily": daily,
	}, nil
}

type headline struct {
	Title   string    `json:"title"`
	Source  string    `json:"source"`
	Summary string    `json:"summary,omitempty"`
	Time    time.Time `json:"time"`
	Lang    string    `json:"-"`
}

// rss covers RSS 2.0 (channel/item) and Atom (entry) in one struct.
type rss struct {
	Items []struct {
		Title       string `xml:"title"`
		Description string `xml:"description"`
		PubDate     string `xml:"pubDate"`
		Date        string `xml:"date"` // dc:date
	} `xml:"channel>item"`
	Entries []struct {
		Title     string `xml:"title"`
		Summary   string `xml:"summary"`
		Updated   string `xml:"updated"`
		Published string `xml:"published"`
	} `xml:"entry"`
}

func parseFeedTime(s string) time.Time {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC1123Z, time.RFC1123, time.RFC3339, "Mon, 2 Jan 2006 15:04:05 -0700", "Mon, 2 Jan 2006 15:04:05 MST", "2006-01-02T15:04:05Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func stripTags(s string) string {
	var b strings.Builder
	in := false
	for _, r := range s {
		switch {
		case r == '<':
			in = true
		case r == '>':
			in = false
		case !in:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func (w *webTools) fetchFeed(ctx context.Context, f Feed) ([]headline, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", f.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "duet-assistant/0.1 (+home)")
	resp, err := w.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s: %s", f.URL, resp.Status)
	}
	var doc rss
	dec := xml.NewDecoder(io.LimitReader(resp.Body, 8<<20))
	dec.Strict = false
	dec.CharsetReader = func(charset string, in io.Reader) (io.Reader, error) { return in, nil }
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	var out []headline
	for _, it := range doc.Items {
		t := parseFeedTime(it.PubDate)
		if t.IsZero() {
			t = parseFeedTime(it.Date)
		}
		out = append(out, headline{Title: stripTags(it.Title), Summary: truncate(stripTags(it.Description), 240), Time: t, Source: f.Name, Lang: f.Lang})
	}
	for _, e := range doc.Entries {
		t := parseFeedTime(e.Published)
		if t.IsZero() {
			t = parseFeedTime(e.Updated)
		}
		out = append(out, headline{Title: stripTags(e.Title), Summary: truncate(stripTags(e.Summary), 240), Time: t, Source: f.Name, Lang: f.Lang})
	}
	return out, nil
}

func (w *webTools) news(ctx context.Context, topic, lang string) (any, error) {
	w.mu.Lock()
	cached, fresh := w.newsCache, time.Since(w.newsAt) < 10*time.Minute
	w.mu.Unlock()
	if !fresh {
		var (
			mu  sync.Mutex
			wg  sync.WaitGroup
			all []headline
		)
		for _, f := range w.feeds {
			wg.Add(1)
			go func(f Feed) {
				defer wg.Done()
				h, err := w.fetchFeed(ctx, f)
				if err != nil {
					return
				}
				mu.Lock()
				all = append(all, h...)
				mu.Unlock()
			}(f)
		}
		wg.Wait()
		if len(all) == 0 && len(w.feeds) > 0 {
			return nil, errors.New("no news feed could be read")
		}
		sort.Slice(all, func(i, j int) bool { return all[i].Time.After(all[j].Time) })
		w.mu.Lock()
		w.newsCache, w.newsAt = all, time.Now()
		w.mu.Unlock()
		cached = all
	}
	pick := func(lang, topic string) []headline {
		ft := fold(topic)
		var out []headline
		for _, h := range cached {
			if lang != "" && h.Lang != "" && h.Lang != lang {
				continue
			}
			if ft != "" && !strings.Contains(fold(h.Title+" "+h.Summary), ft) {
				continue
			}
			out = append(out, h)
			if len(out) == 8 {
				break
			}
		}
		return out
	}
	// Loosen the filter step by step rather than answer "no news": a topic in
	// the other language's feeds, then the latest headlines.
	for _, try := range [][2]string{{lang, topic}, {"", topic}, {lang, ""}, {"", ""}} {
		if out := pick(try[0], try[1]); len(out) > 0 {
			return map[string]any{"filter": map[string]string{"language": try[0], "topic": try[1]}, "headlines": out}, nil
		}
	}
	return nil, errors.New("the news feeds are empty")
}
