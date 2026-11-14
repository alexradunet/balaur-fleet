package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// writeFile replaces a file by a write and a rename, so a reader (Syncthing,
// the keeper) never sees half of it. The temporary name is one that Syncthing
// ignores and the checker skips. A new file gets mode 0660: the folder belongs
// to the group lifelog.
func writeFile(path string, data []byte) error {
	mode := os.FileMode(0o660)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o770); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".syncthing."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op after the rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// inFolder resolves a path given on the command line (relative to the folder,
// or absolute inside it) to its path relative to the folder, slash separated.
func inFolder(folder, p string) (string, error) {
	if filepath.IsAbs(p) {
		rel, err := filepath.Rel(folder, p)
		if err != nil {
			return "", err
		}
		p = rel
	}
	p = filepath.ToSlash(filepath.Clean(p))
	if p == "." || p == ".." || strings.HasPrefix(p, "../") || filepath.IsAbs(p) {
		return "", fmt.Errorf("%s is not inside the folder %s", p, folder)
	}
	return p, nil
}
