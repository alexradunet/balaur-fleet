"""wow-market: World of Warcraft: Forever's auction house, from Auctionator's scans.

Auctionator (the add-on) keeps the lowest buyout and the number listed of every item
it saw in its last scan, and writes them to its SavedVariables file when the game
reloads its UI or logs out. This service watches that file, keeps each new scan, and
serves a page that turns the prices into decisions:

  crafts      every recipe of a profession whose result and materials are on the AH
              (or sold by vendors: thread, salt, dyes...), with the profit of
              crafting over selling the materials
  vendor      listings cheaper than a vendor pays for them
  essences    combining or splitting enchanting essences
  usual       items listed well below or above their median over the past scans
  item        one item's history, scan by scan

GET /api/report returns the same as JSON (for the OS agent).

Item names and recipes are Forever's own: the game tables of the installed build
(.build.info), fetched once per build from wago.tools and kept small in
$STATE_DIRECTORY/data. Scans are kept in $STATE_DIRECTORY/scans/<realm>/.

Vendor prices come from the game itself: Blizzard changes some from its servers
after the tables are made (an Iron Grenade is 5s in them, 1s 25c in the game). The
Balaur Market add-on (BalaurMarket/, next to this file) asks the game for the vendor
price of every item Auctionator has seen and saves them on /reload; this service
installs it into the AddOns folder and keeps it current. Only those prices make a
vendor deal; the tables' are used for vendor-sold materials (thread, salt) alone.

That add-on folder is all it writes in the game's folder. Nothing reaches the game
while it runs (add-ons cannot talk to the network), and buying stays a click in it.

Usage: market.py CONFIG.json  (written by modules/wow-market.nix)
"""

import csv
import glob
import gzip
import hashlib
import html
import http.server
import io
import json
import os
import re
import statistics
import sys
import threading
import time
import urllib.parse
import urllib.request

import cbor2

CONFIG = json.load(open(sys.argv[1]))
STATE = os.environ.get("STATE_DIRECTORY", "/var/lib/wow-market")
GAME_ROOT = CONFIG["gameRoot"]  # ".../World of Warcraft"
GAME = os.path.join(GAME_ROOT, CONFIG["flavour"])  # ".../_forever_"
AH_CUT = 0.05

PROFESSIONS = {
    164: "Blacksmithing",
    165: "Leatherworking",
    171: "Alchemy",
    185: "Cooking",
    186: "Mining",
    197: "Tailoring",
    202: "Engineering",
    333: "Enchanting",
    129: "First Aid",
}

# Materials vendors sell in unlimited numbers: costed at the vendor's price (or the
# AH's, when lower). Everything else is costed at the AH.
VENDOR_GOODS = {
    2320, 2321, 4291, 8343, 14341,  # threads
    4289,  # salt
    2324, 2604, 2605, 2325, 4340, 4341, 4342, 6260, 6261, 10290,  # bleach, dyes
    3371, 3372, 8925, 18256,  # vials
    2880, 3466,  # flux
    2678, 2692, 3713,  # spices
    159, 1179,  # water, milk
    4470, 4399, 4400,  # wood, stocks
    6217,  # copper rod
}

# Enchanting essences: three lesser make one greater, and one greater splits back
# into three. A right-click on the item, not a recipe in the tables.
ESSENCES = [
    ("Magic", 10938, 10939),
    ("Astral", 10998, 11082),
    ("Mystic", 11134, 11135),
    ("Nether", 11174, 11175),
    ("Eternal", 16202, 16203),
]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- game data


def game_build():
    """The installed Forever build ("1.60.1.70862"), from Battle.net's .build.info."""
    try:
        with open(os.path.join(GAME_ROOT, ".build.info"), encoding="utf-8") as f:
            rows = [l.rstrip("\r\n").split("|") for l in f if l.strip()]
    except OSError:
        return None
    head = [h.split("!")[0] for h in rows[0]]
    for r in rows[1:]:
        row = dict(zip(head, r))
        if row.get("Product") == CONFIG["product"] and row.get("Active") == "1":
            return row.get("Version")
    return None


def wago_csv(table, build=None, product=None):
    query = f"build={build}" if build else f"product={product}"
    url = f"https://wago.tools/db2/{table}/csv?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": "balaur-wow-market"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("utf-8")
    if "ID" not in text.split("\n", 1)[0].split(","):
        raise ValueError(f"{table}: wago.tools sent something other than the table")
    return csv.DictReader(io.StringIO(text))


def build_data(build):
    """Items (name, vendor sell and buy price) and recipes, from the game tables."""
    csv.field_size_limit(1 << 30)
    items = {}
    for r in wago_csv("ItemSparse", build):
        items[int(r["ID"])] = [r["Display_lang"], int(r["SellPrice"] or 0), int(r["BuyPrice"] or 0)]
    # Forever leaves some old items out of its own table (it sends them to the game
    # later). Classic Era's table still names them; its vendor prices are not
    # Forever's, so those items get none.
    for r in wago_csv("ItemSparse", product="wow_classic_era"):
        items.setdefault(int(r["ID"]), [r["Display_lang"], 0, 0])
    spells = {}
    for r in wago_csv("SkillLineAbility", build):
        skill = int(r["SkillLine"] or 0)
        if skill in PROFESSIONS:
            spells[int(r["Spell"])] = skill
    creates = {}
    for r in wago_csv("SpellEffect", build):
        s = int(r["SpellID"])
        if s in spells and r["Effect"] == "24" and r["EffectItemType"] not in ("", "0"):
            creates[s] = (int(r["EffectItemType"]), max(1, int(float(r["EffectBasePointsF"] or 1))))
    recipes = []
    for r in wago_csv("SpellReagents", build):
        s = int(r["SpellID"])
        if s not in creates:
            continue
        mats = [
            [int(r[f"Reagent_{i}"]), int(r[f"ReagentCount_{i}"])]
            for i in range(8)
            if r.get(f"Reagent_{i}") not in (None, "", "0")
        ]
        if mats:
            out, n = creates[s]
            recipes.append([PROFESSIONS[spells[s]], out, n, mats])
    return {"build": build, "items": items, "recipes": recipes}


_data = {"build": None, "items": {}, "recipes": []}
_data_lock = threading.Lock()


def load_data():
    """Loads the cached tables of the installed build, fetching them when missing."""
    build = game_build()
    if not build or build == _data["build"]:
        return
    path = os.path.join(STATE, "data", f"{build}.v2.json.gz")
    if not os.path.exists(path):
        log(f"fetching the game tables of {build} from wago.tools")
        try:
            data = build_data(build)
        except Exception as e:  # keep the old tables until the next try
            log(f"could not fetch the tables of {build}: {e}")
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with gzip.open(path + ".tmp", "wt", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(path + ".tmp", path)
    with gzip.open(path, "rt", encoding="utf-8") as f:
        data = json.load(f)
    data["items"] = {int(k): v for k, v in data["items"].items()}
    with _data_lock:
        _data.update(data)
    log(f"game tables of {build}: {len(data['items'])} items, {len(data['recipes'])} recipes")


# ---------------------------------------------------------------- scans


def lua_string(raw, p):
    """Reads the Lua string literal starting after the quote at raw[p-1]."""
    out = bytearray()
    esc = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("a"): 7, ord("b"): 8, ord("f"): 12, ord("v"): 11}
    while True:
        c = raw[p]
        if c == 0x22:
            return bytes(out)
        if c == 0x5C:
            n = raw[p + 1]
            if 0x30 <= n <= 0x39:
                j = p + 1
                while j < p + 4 and 0x30 <= raw[j] <= 0x39:
                    j += 1
                out.append(int(raw[p + 1 : j]))
                p = j
                continue
            if n == 0x0A:
                out.append(10)
            else:
                out.append(esc.get(n, n))
            p += 2
            continue
        out.append(c)
        p += 1


def read_saved_variables(path):
    """{realm: {item id: (lowest buyout, number listed)}} from Auctionator.lua."""
    raw = open(path, "rb").read()
    start = raw.find(b"AUCTIONATOR_PRICE_DATABASE = {")
    if start < 0:
        return {}
    end = raw.find(b"\n}", start)
    realms = {}
    for m in re.finditer(rb'\["([^"]+)"\] = "', raw[start:end]):
        db = cbor2.loads(lua_string(raw, start + m.end()))
        records = {}
        for key, v in db.items():
            key = key.decode("latin1") if isinstance(key, bytes) else str(key)
            if not key.isdigit() or not isinstance(v, dict):
                continue
            v = {(k.decode() if isinstance(k, bytes) else k): x for k, x in v.items()}
            if "m" not in v:
                continue
            days = {
                str(k.decode() if isinstance(k, bytes) else k): x
                for k, x in (v.get("h") or {}).items()
            }
            listed = {
                str(k.decode() if isinstance(k, bytes) else k): x
                for k, x in (v.get("a") or {}).items()
            } if isinstance(v.get("a"), dict) else {}
            records[int(key)] = (int(v["m"]), days, listed)
        # Auctionator never removes an item that sold out: its last price stays. Only
        # items it saw on the newest scan day are on the AH now (its days count from
        # its own day 0; the highest one present is the scan's).
        today = max((int(d) for _, days, _ in records.values() for d in days), default=None)
        prices = {}
        for i, (low, days, listed) in records.items():
            if today is not None and str(today) not in days:
                continue
            prices[i] = (low, int(listed.get(str(today), 0)))
        realms[m.group(1).decode("utf-8", "replace")] = prices
    return realms


def realm_dir(realm):
    return os.path.join(STATE, "scans", re.sub(r"[^A-Za-z0-9_-]", "_", realm))


def scan_files(realm):
    d = realm_dir(realm)
    try:
        return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".json.gz"))
    except FileNotFoundError:
        return []


def read_scan(path):
    with gzip.open(path, "rt") as f:
        s = json.load(f)
    s["p"] = {int(k): tuple(v) for k, v in s["p"].items()}
    return s


_seen = {}  # path -> mtime
_game_sell = {}  # item id -> what a vendor pays, as the game said (Balaur Market)


def install_addon():
    """Copies the Balaur Market add-on into the AddOns folder when it differs."""
    addons = os.path.join(GAME, "Interface", "AddOns")
    if not os.path.isdir(addons):
        return
    src, dst = CONFIG["addon"], os.path.join(addons, "BalaurMarket")
    for name in sorted(os.listdir(src)):
        new = open(os.path.join(src, name), "rb").read()
        try:
            if open(os.path.join(dst, name), "rb").read() == new:
                continue
        except OSError:
            pass
        os.makedirs(dst, exist_ok=True)
        with open(os.path.join(dst, name), "wb") as f:
            f.write(new)
        log(f"installed {name} of the Balaur Market add-on")


def read_game_sell():
    """Merges every account's Balaur Market prices into _game_sell."""
    for path in glob.glob(os.path.join(GAME, "WTF", "Account", "*", "SavedVariables", "BalaurMarket.lua")):
        try:
            mtime = os.stat(path).st_mtime
            if _seen.get(path) == mtime:
                continue
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        _seen[path] = mtime
        start = text.find('["sell"] = {')
        if start < 0:
            continue
        block = text[start : text.find("}", start)]
        prices = {int(i): int(p) for i, p in re.findall(r"\[(\d+)\] = (\d+)", block)}
        _game_sell.update(prices)
        _cache.clear()
        log(f"vendor prices from the game: {len(prices)} items")


def poll():
    """Keeps every scan the saved file holds that is new since the last one kept."""
    for path in glob.glob(os.path.join(GAME, "WTF", "Account", "*", "SavedVariables", "Auctionator.lua")):
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            continue
        if _seen.get(path) == mtime:
            continue
        try:
            realms = read_saved_variables(path)
        except Exception as e:  # half-written, or a format change: try again later
            log(f"could not read {path}: {e}")
            continue
        _seen[path] = mtime
        for realm, prices in realms.items():
            if not prices:
                continue
            digest = hashlib.sha256(json.dumps(sorted(prices.items())).encode()).hexdigest()
            files = scan_files(realm)
            if files and read_scan(files[-1]).get("digest") == digest:
                continue
            d = realm_dir(realm)
            os.makedirs(d, exist_ok=True)
            out = os.path.join(d, f"{int(mtime)}.json.gz")
            with gzip.open(out + ".tmp", "wt") as f:
                json.dump({"t": int(mtime), "realm": realm, "digest": digest, "p": prices}, f)
            os.replace(out + ".tmp", out)
            log(f"kept a scan of {realm}: {len(prices)} items")
            _cache.clear()


def watcher():
    while True:
        try:
            load_data()
            install_addon()
            read_game_sell()
            poll()
        except Exception as e:
            log(f"watcher: {e}")
        time.sleep(CONFIG["pollSeconds"])


# ---------------------------------------------------------------- analysis

_cache = {}


def realms():
    try:
        names = os.listdir(os.path.join(STATE, "scans"))
    except FileNotFoundError:
        return []
    out = []
    for n in names:
        files = scan_files(n)
        if files:
            out.append((n, int(os.path.basename(files[-1]).split(".")[0]), len(files)))
    return sorted(out, key=lambda r: -r[1])


def history(realm, days):
    key = ("history", realm, days)
    if key not in _cache:
        cutoff = time.time() - days * 86400
        _cache[key] = [read_scan(f) for f in scan_files(realm) if int(os.path.basename(f).split(".")[0]) >= cutoff]
    return _cache[key]


def report(realm, profession):
    scans = history(realm, CONFIG["historyDays"])
    if not scans:
        return None
    now = scans[-1]["p"]
    with _data_lock:
        items, recipes = _data["items"], _data["recipes"]
    name = lambda i: items.get(i, [f"item {i}"])[0]
    medians = {}
    for i in now:
        seen = [s["p"][i][0] for s in scans if i in s["p"]]
        if len(seen) >= CONFIG["minScansForUsual"]:
            medians[i] = statistics.median(seen)

    def unit_cost(i):
        ah = now.get(i, (None,))[0]
        vend = items[i][2] if i in VENDOR_GOODS and i in items and items[i][2] > 0 else None
        costs = [c for c in (ah, vend) if c is not None]
        return min(costs) if costs else None

    crafts = []
    for prof, out, n, mats in recipes:
        if prof != profession or out not in now:
            continue
        costs = [unit_cost(i) for i, _ in mats]
        if None in costs:
            continue
        cost = sum(c * k for c, (_, k) in zip(costs, mats))
        sells = now[out][0] * n * (1 - AH_CUT)
        crafts.append(
            {
                "item": name(out),
                "id": out,
                "makes": n,
                "materials": [[name(i), k] for i, k in mats],
                "cost": round(cost),
                "sells": round(sells),
                "profit": round(sells - cost),
                "listed": now[out][1],
                "usual": medians.get(out),
            }
        )
    crafts.sort(key=lambda c: -c["profit"])

    # Only the game's own vendor prices: the tables' are wrong for some items.
    vendor = [
        {"item": name(i), "id": i, "buyout": m, "vendor": _game_sell[i], "profit": _game_sell[i] - m, "listed": n}
        for i, (m, n) in now.items()
        if _game_sell.get(i, 0) > m
    ]
    vendor.sort(key=lambda v: -v["profit"])

    essences = []
    for kind, lesser, greater in ESSENCES:
        if lesser in now and greater in now:
            pl, pg = now[lesser][0], now[greater][0]
            essences.append({"what": f"3 Lesser → 1 Greater {kind}", "cost": 3 * pl, "sells": round(pg * (1 - AH_CUT)), "profit": round(pg * (1 - AH_CUT) - 3 * pl)})
            essences.append({"what": f"1 Greater → 3 Lesser {kind}", "cost": pg, "sells": round(3 * pl * (1 - AH_CUT)), "profit": round(3 * pl * (1 - AH_CUT) - pg)})
    essences.sort(key=lambda e: -e["profit"])

    cheap, dear = [], []
    for i, med in medians.items():
        m, n = now[i]
        if med < 500:  # under 5s: noise
            continue
        entry = {"item": name(i), "id": i, "now": m, "usual": round(med), "listed": n, "diff": round(med - m)}
        if m <= med * 0.7:
            cheap.append(entry)
        elif m >= med * 1.4:
            dear.append(entry)
    cheap.sort(key=lambda e: -e["diff"])
    dear.sort(key=lambda e: e["diff"])

    return {
        "realm": scans[-1].get("realm", realm),
        "scanned": scans[-1]["t"],
        "scans": len(scans),
        "items": len(now),
        "build": _data["build"],
        "gameVendorPrices": len(_game_sell),
        "profession": profession,
        "crafts": crafts,
        "vendor": vendor,
        "essences": essences,
        "cheap": cheap[:40],
        "dear": dear[:40],
    }


def item_history(realm, query):
    with _data_lock:
        items = _data["items"]
    scans = history(realm, 3650)
    present = set().union(*(s["p"].keys() for s in scans)) if scans else set()
    q = query.lower()
    matches = sorted((i for i in present if i in items and q in items[i][0].lower()), key=lambda i: items[i][0])
    out = []
    for i in matches[:5]:
        rows = [(s["t"], *s["p"][i]) for s in scans if i in s["p"]]
        out.append({"item": items[i][0], "id": i, "vendor": _game_sell.get(i), "history": rows})
    return out


# ---------------------------------------------------------------- page


def money(c):
    if c is None:
        return "–"
    c = int(round(c))
    sign = "−" if c < 0 else ""
    c = abs(c)
    parts = []
    if c >= 10000:
        parts.append(f'<span class="g">{c // 10000}g</span>')
    if c >= 100:
        parts.append(f'<span class="s">{c // 100 % 100}s</span>')
    parts.append(f'<span class="c">{c % 100}c</span>')
    return sign + " ".join(parts)


def when(t):
    return time.strftime("%a %d %b %H:%M", time.localtime(t))


CSS = """
:root{--bg:#f6f4ef;--card:#fff;--fg:#1d1b18;--mute:#6b665d;--line:#e4dfd4;--good:#1f7a3a;--bad:#a8322d;--accent:#8a5a00;--g:#a07800;--s:#6d7480;--c:#9a5b2c}
@media (prefers-color-scheme:dark){:root{--bg:#16150f;--card:#1f1e18;--fg:#ece8de;--mute:#a19b8e;--line:#34322a;--good:#5cc47b;--bad:#ec7a73;--accent:#e0b04a;--g:#e6c14a;--s:#b7bec9;--c:#d9935e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 8px}
.sub{color:var(--mute);margin:2px 0 14px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);font-weight:600}tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}td.mats{white-space:normal;color:var(--mute);font-size:13px;min-width:220px}
.pos{color:var(--good);font-weight:600}.neg{color:var(--bad)}.g{color:var(--g)}.s{color:var(--s)}.c{color:var(--c)}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}nav a{padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--fg);text-decoration:none;font-size:13px;background:var(--card)}
nav a.on{background:var(--accent);border-color:var(--accent);color:var(--bg)}form{display:flex;gap:6px;margin:8px 0}
input{flex:1;max-width:320px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
button{padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
.note{color:var(--mute);font-size:13px;margin:6px 2px}.empty{padding:12px;color:var(--mute)}
"""


def table(head, rows, empty="Nothing right now."):
    if not rows:
        return f'<div class="card"><div class="empty">{empty}</div></div>'
    th = "".join(f'<th class="{c}">{html.escape(h)}</th>' for h, c in head)
    body = "".join("<tr>" + "".join(r) + "</tr>" for r in rows)
    return f'<div class="card"><table><tr>{th}</tr>{body}</table></div>'


def td(v, cls=""):
    return f'<td class="{cls}">{v}</td>'


def profit_td(p):
    return td(money(p), "num " + ("pos" if p > 0 else "neg"))


def page(realm, profession, query):
    known = realms()
    if not known:
        return render("<p>No scan yet. In the game, open the auction house, run Auctionator's Full Scan, then type /reload. The scan shows up here within a minute.</p>")
    realm = realm if realm in [r[0] for r in known] else known[0][0]
    r = report(realm, profession)
    q = lambda **kw: "?" + urllib.parse.urlencode({"realm": realm, "prof": profession, **kw})
    out = [
        f'<p class="sub">{html.escape(r["realm"])} · last scan {when(r["scanned"])} · {r["items"]} items · '
        f'{r["scans"]} scans in {CONFIG["historyDays"]} days · game data {html.escape(r["build"] or "loading")} · '
        f'vendor prices of {r["gameVendorPrices"]} items from the game</p>'
    ]
    if len(known) > 1:
        out.append("<nav>" + "".join(f'<a class="{"on" if n == realm else ""}" href="?realm={urllib.parse.quote(n)}">{html.escape(n)}</a>' for n, _, _ in known) + "</nav>")
    out.append(f'<form method="get"><input type="hidden" name="realm" value="{html.escape(realm)}"><input type="hidden" name="prof" value="{html.escape(profession)}">'
               f'<input name="q" placeholder="An item\'s price history" value="{html.escape(query)}"><button>Look up</button></form>')
    if query:
        for it in item_history(realm, query):
            rows = [[td(when(t)), td(money(m), "num"), td(n, "num")] for t, m, n in reversed(it["history"])]
            out.append(f'<h2>{html.escape(it["item"])} <span class="note">vendor pays {money(it["vendor"]) if it["vendor"] is not None else "unknown yet"}</span></h2>')
            out.append(table([("Scan", ""), ("Lowest buyout", "num"), ("Listed", "num")], rows))
        if not item_history(realm, query):
            out.append(f'<p class="note">No item matching “{html.escape(query)}” in the scans.</p>')

    out.append("<h2>Crafts</h2><nav>" + "".join(f'<a class="{"on" if p == profession else ""}" href="{q(prof=p)}">{p}</a>' for p in sorted(set(PROFESSIONS.values()))) + "</nav>")
    out.append('<p class="note">Profit over selling the materials at their lowest buyout, after the 5% cut. Vendor goods (thread, salt, dyes, vials) at the vendor\'s price. '
               'Few listed means it sells slowly: make one or two. Recipes you have not learned are listed too.</p>')
    rows = []
    for c in r["crafts"]:
        mats = ", ".join(f"{k}× {html.escape(n)}" for n, k in c["materials"])
        usual = f' <span class="note">usual {money(c["usual"])}</span>' if c["usual"] else ""
        rows.append([td(html.escape(c["item"]) + (f" ×{c['makes']}" if c["makes"] > 1 else "")), td(mats, "mats"), td(money(c["cost"]), "num"),
                     td(money(c["sells"]) + usual, "num"), profit_td(c["profit"]), td(c["listed"], "num")])
    out.append(table([("Craft", ""), ("Materials", ""), ("Cost", "num"), ("Sells for", "num"), ("Profit", "num"), ("Listed", "num")], rows,
                     "No recipe of this profession has its result and all its materials in the scan."))

    out.append("<h2>Buy, then sell to a vendor</h2>")
    out.append(table([("Item", ""), ("Lowest buyout", "num"), ("Vendor pays", "num"), ("Profit each", "num"), ("Listed", "num")],
                     [[td(html.escape(v["item"])), td(money(v["buyout"]), "num"), td(money(v["vendor"]), "num"), profit_td(v["profit"]), td(v["listed"], "num")] for v in r["vendor"]],
                     "Nothing below vendor price in the last scan." if r["gameVendorPrices"] else
                     "No vendor prices from the game yet: log in with the Balaur Market add-on enabled, wait a minute, then /reload."))
    out.append('<p class="note">Vendor prices are the game\'s own (the Balaur Market add-on). Only the lowest listing is known: '
               'check how many are at that price before buying.</p>')

    out.append("<h2>Enchanting essences</h2>")
    out.append(table([("Right-click", ""), ("Cost", "num"), ("Sells for", "num"), ("Profit", "num")],
                     [[td(e["what"]), td(money(e["cost"]), "num"), td(money(e["sells"]), "num"), profit_td(e["profit"])] for e in r["essences"]]))

    need = CONFIG["minScansForUsual"]
    out.append(f"<h2>Cheaper than usual</h2><p class=\"note\">At least 30% under the median of the last {CONFIG['historyDays']} days; needs {need} scans of an item.</p>")
    out.append(table([("Item", ""), ("Now", "num"), ("Usual", "num"), ("Under by", "num"), ("Listed", "num")],
                     [[td(html.escape(e["item"])), td(money(e["now"]), "num"), td(money(e["usual"]), "num"), profit_td(e["diff"]), td(e["listed"], "num")] for e in r["cheap"]],
                     f"Nothing yet: this needs {need} scans."))
    out.append("<h2>Dearer than usual: a good time to sell</h2>")
    out.append(table([("Item", ""), ("Now", "num"), ("Usual", "num"), ("Over by", "num"), ("Listed", "num")],
                     [[td(html.escape(e["item"])), td(money(e["now"]), "num"), td(money(e["usual"]), "num"), profit_td(-e["diff"]), td(e["listed"], "num")] for e in r["dear"]],
                     f"Nothing yet: this needs {need} scans."))
    return render("".join(out))


def render(body):
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>WoW Market</title><style>{CSS}</style></head><body><main><h1>WoW Market</h1>{body}</main></body></html>")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        args = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query).items()}
        realm, prof = args.get("realm", ""), args.get("prof", CONFIG["profession"])
        if prof not in PROFESSIONS.values():
            prof = CONFIG["profession"]
        try:
            if url.path == "/api/report":
                known = realms()
                realm = realm or (known[0][0] if known else "")
                body = json.dumps(report(realm, prof) if known else None).encode()
                ctype = "application/json"
            elif url.path == "/":
                body = page(realm, prof, args.get("q", "").strip()).encode()
                ctype = "text/html; charset=utf-8"
            else:
                self.send_error(404)
                return
        except Exception as e:
            log(f"{self.path}: {e!r}")
            self.send_error(500)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=watcher, daemon=True).start()
    server = http.server.ThreadingHTTPServer(("", CONFIG["port"]), Handler)
    log(f"listening on {CONFIG['port']}, watching {GAME}")
    server.serve_forever()
