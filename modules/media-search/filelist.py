# VERSION: 1.0
# AUTHORS: duet home server
#
# qBittorrent search plugin for FileList (filelist.io), via its JSON API.
# Credentials are read from $FILELIST_CREDENTIALS (set by modules/media.nix),
# a JSON file {"username": ..., "passkey": ...} written by `sudo duet-filelist-login`.
# They never appear in this file, the repo or the Nix store.

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from novaprinter import prettyPrinter

API = "https://filelist.io/api.php"
SITE = "https://filelist.io"

# qBittorrent category -> prefixes of the API's category names (filtered
# locally, so this does not depend on FileList's numeric category ids). Names
# as the API returns them, e.g. "Movies 4K", "TV-Series HD", "Games PC";
# "RO Dubbed" holds both films and series.
CATEGORIES = {
    "movies": ("Movies", "RO Dubbed"),
    "tv": ("TV-Series", "K-Drama", "RO Dubbed"),
    "anime": ("Anime", "Cartoons"),
    "music": ("Music", "FLAC", "Videoclip"),
    "games": ("Games",),
    "software": ("Apps", "Linux", "Mobile"),
    "books": ("Books", "Docs", "Courses"),
}


class filelist(object):
    url = SITE
    name = "FileList"
    supported_categories = {"all": "", **{c: c for c in CATEGORIES}}

    def _notice(self, text):
        # qBittorrent shows no plugin errors, so explain problems as a result row.
        prettyPrinter({
            "link": SITE, "name": "FileList: " + text, "size": "0", "seeds": "0",
            "leech": "0", "engine_url": SITE, "desc_link": SITE,
        })

    def _credentials(self):
        path = os.environ.get("FILELIST_CREDENTIALS", "/var/lib/qBittorrent/filelist.json")
        try:
            with open(path) as f:
                c = json.load(f)
            return c["username"], c["passkey"]
        except (OSError, ValueError, KeyError):
            return None

    def search(self, what, cat="all"):
        creds = self._credentials()
        if not creds:
            self._notice("not logged in. On the Duet run: sudo duet-filelist-login")
            return
        query = urllib.parse.unquote(what).replace("+", " ").strip()
        imdb = query.lower().startswith("tt") and query[2:].isdigit()
        params = {
            "username": creds[0], "passkey": creds[1], "action": "search-torrents",
            "type": "imdb" if imdb else "name", "query": query,
        }
        req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params),
                                     headers={"User-Agent": "qBittorrent search plugin"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            try:
                msg = json.load(e).get("error") or e.reason
            except ValueError:
                msg = e.reason
            self._notice("%s (HTTP %d)" % (msg, e.code))
            return
        except (OSError, ValueError) as e:
            self._notice("unreachable: %s" % e)
            return
        if isinstance(data, dict):  # {"error": "..."}
            self._notice(str(data.get("error", data)))
            return

        prefixes = CATEGORIES.get(cat)
        for t in data:
            category = t.get("category") or ""
            if prefixes and not category.startswith(prefixes):
                continue
            tags = [category] if category else []
            if t.get("freeleech"):
                tags.append("FREELEECH")
            if t.get("doubleup"):
                tags.append("2x UP")
            try:
                pub = int(time.mktime(time.strptime(t.get("upload_date", ""), "%Y-%m-%d %H:%M:%S")))
            except ValueError:
                pub = -1
            prettyPrinter({
                "link": t["download_link"],
                "name": "%s [%s]" % (t["name"], ", ".join(tags)) if tags else t["name"],
                "size": str(t.get("size", 0)),
                "seeds": str(t.get("seeders", 0)),
                "leech": str(t.get("leechers", 0)),
                "engine_url": SITE,
                "desc_link": "%s/details.php?id=%s" % (SITE, t.get("id")),
                "pub_date": pub,
            })
