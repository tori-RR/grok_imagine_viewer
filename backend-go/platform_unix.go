//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func reparse(fi os.FileInfo) bool   { return false }
func lockFile(f *os.File) error     { return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func unlockFile(f *os.File)         { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
func replaceFile(a, b string) error { return os.Rename(a, b) }

// Link is no-replace on the same filesystem. Retain both links on an uncertain
// unlink; the journal resolves that state rather than deleting by guess.
func moveNoReplace(a, b string) error {
	if e := os.Link(a, b); e != nil {
		return e
	}
	return os.Remove(a)
}
func publishNoReplace(a, b string) error { return moveNoReplace(a, b) }
func syncDir(p string) {
	if f, e := os.Open(p); e == nil {
		_ = f.Sync()
		f.Close()
	}
}
func freeSpace(p string) (uint64, error) {
	var s syscall.Statfs_t
	e := syscall.Statfs(p, &s)
	return uint64(s.Bavail) * uint64(s.Bsize), e
}
func quietProcess(cmd *os.ProcAttr) {}

func hideCommand(cmd *exec.Cmd) {}
