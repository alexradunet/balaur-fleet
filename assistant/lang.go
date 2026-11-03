package main

// Romanian or English? Used to pick the voice for a reply. Whisper reports the
// language when it can; otherwise (and for typed text) this heuristic decides.

import (
	"strings"
	"unicode"
)

var roWords = toSet("și si sa să nu da este e un o în in la de pe cu ce cum când cand unde care mai foarte pentru " +
	"din am ai are avem aveți sunt ești esti eu tu el ea noi voi ei ele mă ma te îmi imi îți iti " +
	"lista listă cumpărături cumparaturi adaugă adauga pune șterge sterge spune vremea mâine maine azi astăzi " +
	"astazi ora cât cat câte cate minute secunde aminteste amintește ține tine minte bună buna mulțumesc multumesc " +
	"vreau poți poti te rog acum ieri săptămâna saptamana")

var enWords = toSet("the a an is are was were be to of and in on at for with what how when where who which " +
	"i you he she we they me my your it this that please can could would will add remove list shopping " +
	"tell weather tomorrow today time timer minutes seconds remind remember thanks thank hello hi set")

func toSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(s) {
		m[w] = true
	}
	return m
}

// detectLang returns "ro", "en", or "" when it cannot tell.
func detectLang(text string) string {
	ro, en := 0, 0
	for _, r := range text {
		switch r {
		case 'ă', 'â', 'î', 'ș', 'ş', 'ț', 'ţ', 'Ă', 'Â', 'Î', 'Ș', 'Ş', 'Ț', 'Ţ':
			ro += 2
		}
	}
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) })
	for _, w := range words {
		if roWords[w] {
			ro++
		}
		if enWords[w] {
			en++
		}
	}
	switch {
	case ro > en:
		return "ro"
	case en > ro:
		return "en"
	}
	return ""
}

// looksRoOrEn is false for text that is plainly another language: letters
// outside the Latin alphabet plus Romanian diacritics (ü, ö, ğ, ı, é, Cyrillic, ...),
// or several words of which none is a known Romanian or English word.
func looksRoOrEn(text string) bool {
	for _, r := range text {
		if !unicode.IsLetter(r) || r < 0x80 {
			continue
		}
		switch r {
		case 'ă', 'â', 'î', 'ș', 'ş', 'ț', 'ţ', 'Ă', 'Â', 'Î', 'Ș', 'Ş', 'Ț', 'Ţ':
		default:
			return false
		}
	}
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) })
	return len(words) < 3 || detectLang(text) != ""
}

// normLang maps whatever Whisper reports ("ro", "romanian", "en-US") to "ro"/"en"/"".
func normLang(s string) string {
	s = strings.ToLower(s)
	switch {
	case strings.HasPrefix(s, "ro"):
		return "ro"
	case strings.HasPrefix(s, "en"):
		return "en"
	}
	return ""
}

// fold lowercases and strips Romanian diacritics, for forgiving matches
// ("Lapte" == "lapte", "cumpărături" == "cumparaturi").
func fold(s string) string {
	r := strings.NewReplacer("ă", "a", "â", "a", "î", "i", "ș", "s", "ş", "s", "ț", "t", "ţ", "t")
	return strings.TrimSpace(r.Replace(strings.ToLower(s)))
}
