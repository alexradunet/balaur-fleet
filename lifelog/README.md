# lifelog

The owner's life log as plain files: markdown pages and CSV readings in `/srv/life`, synced by Syncthing between
the tablet, the laptop and the pc. A keeper on the tablet commits every settled state to git and moves the ref
`checked` to each state that passes its checker. It replaces aminte, and is built next to it.

- [The design](docs/design.md): the model, the layout, the keeper and the rules of the checker.
- [Plan 001](docs/plans/001-spikes.md): the spikes and their results.
- [Plan 002](docs/plans/002-into-the-fleet.md): the way into the fleet.

**Status:** `lifelog check` holds every rule of design §6: the rules of the tree, and with `-git-dir` the rules that
compare the refs `seen` and `live`. The commands that write files, the package and the aspects follow
([plan 002](docs/plans/002-into-the-fleet.md)).

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
