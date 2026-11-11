// The house's scenes and scripts from Home Assistant, for the Quick Settings
// tile (scenes.js), without any of the Shell so tests/test-ambient.js can run it.
//
// /etc/balaur/house.json (modules/gnome.nix, where the machine's assistant has
// house devices) says where Home Assistant is and which file holds the token:
// the assistant's own non-admin Home Assistant user, readable by the session's
// account (group balaur-assistant). Scenes and scripts are made in Home
// Assistant's UI; this only lists and runs them.

import GLib from 'gi://GLib';

import {Http, readSecret} from './ambient-data.js';

export const HOUSE_PATH = GLib.getenv('BALAUR_HOUSE_CONFIG') ?? '/etc/balaur/house.json';

/** {url, tokenFile} from the config file, or null when this machine has none. */
export function loadHouse(path = HOUSE_PATH) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        const cfg = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof cfg?.url !== 'string' || typeof cfg?.tokenFile !== 'string')
            return null;
        return {url: cfg.url.replace(/\/+$/, ''), tokenFile: cfg.tokenFile};
    } catch (e) {
        if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
            console.warn(`balaur house: ${path}: ${e.message}`);
        return null;
    }
}

const DOMAINS = ['scene', 'script'];

/**
 * Home Assistant's /api/states -> the scenes and scripts to offer, scenes
 * first, each by name: [{entityId, domain, name, icon}]. Unavailable ones
 * (a deleted scene's leftover entity) are left out.
 */
export function actionsOf(states) {
    if (!Array.isArray(states))
        return [];
    const out = [];
    for (const s of states) {
        const id = typeof s?.entity_id === 'string' ? s.entity_id : '';
        const domain = id.split('.')[0];
        if (!DOMAINS.includes(domain) || s.state === 'unavailable')
            continue;
        const name = s.attributes?.friendly_name || id.slice(domain.length + 1).replace(/_/g, ' ');
        out.push({entityId: id, domain, name, icon: iconOf(domain, s.attributes?.icon)});
    }
    const collator = new Intl.Collator(undefined, {sensitivity: 'base'});
    return out.sort((a, b) => DOMAINS.indexOf(a.domain) - DOMAINS.indexOf(b.domain) ||
        collator.compare(a.name, b.name));
}

// Home Assistant's Material icons have no GNOME counterpart, except the few
// that say what a scene is about.
const ICONS = [
    [/lightbulb-off|power|sleep|weather-night/, 'night-light-symbolic'],
    [/lightbulb|lamp|ceiling-light/, 'display-brightness-symbolic'],
    [/movie|television|theater|filmstrip/, 'video-display-symbolic'],
    [/music|speaker/, 'audio-speakers-symbolic'],
];
export function iconOf(domain, mdi = '') {
    for (const [re, icon] of ICONS) {
        if (re.test(mdi ?? ''))
            return icon;
    }
    return domain === 'script' ? 'system-run-symbolic' : 'preferences-desktop-wallpaper-symbolic';
}

/** Turns an action into the service call Home Assistant expects. */
export function callOf(action) {
    return {path: `/api/services/${action.domain}/turn_on`, body: {entity_id: action.entityId}};
}

export class HomeAssistant {
    /** @param {{url: string, tokenFile: string}} cfg */
    constructor(cfg) {
        this._cfg = cfg;
        this._http = new Http();
    }

    // The token is read for each request, so a rotated secret needs no restart.
    _headers() {
        const token = readSecret(this._cfg.tokenFile);
        if (!token)
            throw new Error(`no Home Assistant token in ${this._cfg.tokenFile}`);
        return {Authorization: `Bearer ${token}`};
    }

    async actions(cancellable = null) {
        return actionsOf(await this._http.getJSON(`${this._cfg.url}/api/states`, this._headers(), cancellable));
    }

    async run(action) {
        const {path, body} = callOf(action);
        await this._http.post(`${this._cfg.url}${path}`, body, this._headers());
    }

    destroy() {
        this._http.abort();
    }
}
