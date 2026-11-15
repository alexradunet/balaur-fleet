# lifelog

The owner's life log as plain files: markdown pages and CSV readings in `/srv/life`, synced by Syncthing between
the tablet, the laptop and the pc. A keeper on the tablet commits every settled state to git and moves the ref
`checked` to each state that passes its checker. It replaced aminte on 2026-11-15.

- [The design](docs/design.md): the model, the layout, the keeper and the rules of the checker.
- [Plan 001](docs/plans/001-spikes.md): the spikes and their results.
- [Plan 002](docs/plans/002-into-the-fleet.md): the way into the fleet.
- [Plan 003](docs/plans/003-the-web-app.md): the web app, for the phone ([web/](web/README.md)).

**Status:** the program (`check`, `index`, `new`, `add`, `merge`, `rename-links`, `restore`), its package (`pkgs/lifelog.nix`) and
its aspects (`modules/lifelog.nix`: `lifelog` on the tablet, `lifelog-client` on the laptop and the pc) exist and
build, with the importer from aminte (`lifelog-import`); deployed, with the owner's data imported. What waits for the owner is in [plan 002](docs/plans/002-into-the-fleet.md).

```sh
nix develop                       # from the repo root: Go (the tests also need git)
cd lifelog && go vet ./... && go test ./...
go run . check /path/to/folder    # exit 0: clean or warnings only; 1: an error or a loss; 3: the run failed
go run . check -report -git-dir /var/lib/lifelog/life.git /srv/life   # as the keeper runs it: the text of _check.md
LIFELOG_SCALE=1 go test ./check -run TestScale -v   # spike S5: a fifty-year tree
```

The test vectors are `check/testdata/*.txtar`: a `want` section, then one section per file of a small tree.

The fleet repo is public. The life folder, its git dir and every copy of them never enter it; tests use synthetic
data only.
