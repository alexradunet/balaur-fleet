# lifelog

The owner's life log as plain files: markdown pages and CSV readings in `/srv/life`, synced by Syncthing between
the tablet, the laptop and the pc. A keeper on the tablet commits every settled state to git and moves the ref
`checked` to each state that passes its checker. It replaces aminte, and is built next to it.

- [The design](docs/design.md): the model, the layout, the keeper and the rules of the checker.
- [Plan 001](docs/plans/001-spikes.md): the spikes and their results.
- [Plan 002](docs/plans/002-into-the-fleet.md): the way into the fleet.

**Status: design only.** No code, package or aspect exists yet.

The fleet repo is public. The life folder, its git dir and every copy of them never enter it; tests use synthetic
data only.
