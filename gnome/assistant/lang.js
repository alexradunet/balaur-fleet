// Romanian or English? Used to pick the voice for a reply and the language of
// the conversation. Voxtral reports the language when it can; otherwise (and
// for typed text) this heuristic decides. A port of assistant/lang.go (the former Go service, in git history).

import {trimChars} from './util.js';

export function toSet(s) {
    return new Set(s.split(/\s+/).filter(Boolean));
}

const roWords = toSet('și si sa să nu da este e un o în in la de pe cu ce cum când cand unde care mai foarte pentru ' +
    'din am ai are avem aveți sunt ești esti eu tu el ea noi voi ei ele mă ma te îmi imi îți iti ' +
    'lista listă cumpărături cumparaturi adaugă adauga pune șterge sterge spune vremea mâine maine azi astăzi ' +
    'astazi ora cât cat câte cate minute secunde aminteste amintește ține tine minte bună buna mulțumesc multumesc ' +
    'vreau poți poti te rog acum ieri săptămâna saptamana');

const enWords = toSet('the a an is are was were be to of and in on at for with what how when where who which ' +
    'i you he she we they me my your it this that please can could would will add remove list shopping ' +
    'tell weather tomorrow today time timer minutes seconds remind remember thanks thank hello hi set');

const RO_LETTERS = 'ăâîșşțţĂÂÎȘŞȚŢ';

// strings.FieldsFunc(strings.ToLower(text), !unicode.IsLetter)
function letterWords(text) {
    return text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
}

/** "ro", "en", or "" when it cannot tell. */
export function detectLang(text) {
    let ro = 0, en = 0;
    for (const r of text) {
        if (RO_LETTERS.includes(r))
            ro += 2;
    }
    for (const w of letterWords(text)) {
        if (roWords.has(w))
            ro++;
        if (enWords.has(w))
            en++;
    }
    if (ro > en)
        return 'ro';
    if (en > ro)
        return 'en';
    return '';
}

/**
 * False for text that is plainly another language: letters outside the Latin
 * alphabet plus Romanian diacritics (ü, ö, ğ, ı, é, Cyrillic, ...), or several
 * words of which none is a known Romanian or English word.
 */
export function looksRoOrEn(text) {
    for (const r of text) {
        if (r.codePointAt(0) < 0x80 || !/\p{L}/u.test(r))
            continue;
        if (!RO_LETTERS.includes(r))
            return false;
    }
    return letterWords(text).length < 3 || detectLang(text) !== '';
}

/** Maps whatever STT reports ("ro", "romanian", "en-US") to "ro"/"en"/"". */
export function normLang(s) {
    s = (s ?? '').toLowerCase();
    if (s.startsWith('ro'))
        return 'ro';
    if (s.startsWith('en'))
        return 'en';
    return '';
}

/**
 * Lowercases and strips Romanian diacritics, for forgiving matches
 * ("Lapte" == "lapte", "cumpărături" == "cumparaturi").
 */
export function fold(s) {
    return s.toLowerCase()
        .replace(/[ăâ]/g, 'a').replace(/î/g, 'i').replace(/[șş]/g, 's').replace(/[țţ]/g, 't')
        .trim();
}

// Whisper-style models "hear" these in silence and noise.
const noisePhrases = [
    'thank you for watching', 'thanks for watching', 'subtitles by', 'mulțumesc pentru vizionare',
    'multumesc pentru vizionare', 'abonați-vă', 'abonati-va', 'vă mulțumesc pentru vizionare',
];

export function isNoise(text) {
    const t = fold(trimChars(text, ' .,!?…'));
    if ([...t].length < 2)
        return true;
    return noisePhrases.some(p => t.includes(fold(p)));
}

const stopWords = toSet('stop gata lasa nimic anuleaza taci cancel nevermind never mind nothing quiet ok okay bine mersi multumesc thanks');

export function isStop(text) {
    const t = fold(trimChars(text, ' .,!?…')).split(/\s+/).filter(Boolean).join(' ');
    return stopWords.has(t) || t === 'never mind' || t === 'lasa asta' || t === 'nu mai conteaza';
}

/** Splits text so the first sentence can play while the rest is synthesised. */
export function sentences(text) {
    const out = [];
    const rs = [...text];
    let start = 0;
    rs.forEach((r, i) => {
        if ('.!?…'.includes(r) && (i + 1 === rs.length || rs[i + 1] === ' ')) {
            const s = rs.slice(start, i + 1).join('').trim();
            if (s)
                out.push(s);
            start = i + 1;
        }
    });
    const s = rs.slice(start).join('').trim();
    if (s)
        out.push(s);
    return out;
}

/**
 * Cleans a model reply for text-to-speech: no reasoning blocks, no markdown
 * emphasis, headings or bullets, no bare links.
 */
export function spoken(s) {
    s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    s = s.replace(/https?:\/\/\S+/g, '');
    s = s.replaceAll('**', '').replaceAll('__', '').replaceAll('`', '').replaceAll('#', '');
    const lines = [];
    for (let ln of s.split('\n')) {
        ln = ln.trim();
        ln = ln.replace(/^[-*• ]+/u, '');
        if (ln)
            lines.push(ln);
    }
    return lines.join(' ').trim();
}
