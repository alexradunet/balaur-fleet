# lifelog-web

The life folder on the phone: the journal, the pages, the readings and search, served on the tablet at
`https://life.<domain>` to the owner's own devices. Why and how: [plan 003](../docs/plans/003-the-web-app.md).

- **Node.js, server-rendered HTML** (`src/views.js`), htmx for the search box, a plain text area for the editor.
- **The rules are Go's.** The app asks `lifelog` for the index of the folder (titles, aliases, links), to make a
  page (`new`), to add a reading (`add`) and for the problems after a save (`check -json`).
- **Offline:** the service worker (`public/sw.js`) keeps the app shell; `public/app.js` queues a note or a reading
  in IndexedDB with the phone's day and instant and an id, and sends it when the phone is online. The server
  applies each id once (`src/captures.js`).

| file | what it does |
|---|---|
| `src/server.js` | the routes, the same-origin check, the socket (from systemd, or `LIFELOG_WEB_SOCKET`, or a port) |
| `src/folder.js` | paths kept inside the content folders; reads; atomic writes; the save that refuses a changed file |
| `src/lifelog.js` | the calls to the Go program, and the index, kept until a file changes |
| `src/markdown.js` | markdown and wikilinks as HTML (no raw HTML from a page) |
| `src/readings.js`, `src/search.js` | the CSV files and their chart; full-text search |

```sh
nix develop                                  # from the repo root: Go and Node
cd lifelog && go build -o /tmp/lifelog . && cd web && npm install
LIFELOG_BIN=/tmp/lifelog npm test            # the tests run the real lifelog
LIFELOG_FOLDER=/some/synthetic/folder LIFELOG_BIN=/tmp/lifelog LIFELOG_WEB_STATE=/tmp/state npm start   # http://127.0.0.1:7795
```

Never point it at the real `/srv/life` from a development machine: Syncthing would bring every test edit to all
machines.
