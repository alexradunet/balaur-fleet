// Who opens what: the People page's rules, without GTK (tested headless).
//
// The page describes; it grants nothing. What lets a person in is elsewhere:
// Caddy's gate by source address and the tailnet policy (modules/web.nix),
// and for the screen the plain fact that it sits on the machine. NixOS has
// already worked out the part that depends on the configuration and put it on
// each service in services.json: `shared` (a household device is served it)
// and `login` (it asks for a login of its own). A person is {name, role} from
// people.json (services.js and people.js read the two files).

// What each role means, as the page says it under the person's name.
export const ROLE_TEXT = {
    owner: 'Owner · everything, from their own devices',
    household: 'Household · the shared services, from their own devices',
    screen: 'This screen · no password, whoever is in the room',
};

/** The services there is a page to open for: the rest are not anybody's to open. */
export function openable(services) {
    return services.filter(s => s && s.url);
}

/**
 * Whether `person` reaches `service`'s page.
 * - owner: their devices are served everything.
 * - household: only what is shared with the household's own devices.
 * - screen: whatever this screen lists; this machine's services answer it on
 *   loopback, the other machines' over the tailnet, and no gate is in between.
 * An unknown role opens nothing: a typo must not read as access.
 */
export function canOpen(person, service) {
    if (!service?.url)
        return false;
    switch (person?.role) {
    case 'owner':
    case 'screen':
        return true;
    case 'household':
        return service.shared === true;
    default:
        return false;
    }
}

/** How many of `services` (already `openable`) the person reaches. */
export function countFor(person, services) {
    return services.filter(s => canOpen(person, s)).length;
}

/**
 * The text a person's picture is drawn from. libadwaita's avatar shows the
 * first letter of the first word and of the last, and colours by the text; two
 * one-word names with the same first letter would look alike, so those get
 * their second letter as a word of its own ("Alex", "Andreea": AL, AN).
 */
export function faceText(person, people) {
    const name = (person?.name ?? '').trim();
    const letters = [...name];
    const first = n => [...(n ?? '').trim()][0]?.toLowerCase();
    const clash = people.some(p => p !== person && first(p?.name) === first(name));
    if (clash && letters.length > 1 && !/\s/.test(name))
        return `${letters[0]} ${letters[1]}`;
    return name;
}

/** Under a service's name: whether reaching the page is already using it. */
export function loginText(service) {
    return service?.login ? 'Asks for its own login' : 'No login';
}
