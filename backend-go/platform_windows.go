//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var k32 = syscall.NewLazyDLL("kernel32.dll")
var procLock = k32.NewProc("LockFileEx")
var procUnlock = k32.NewProc("UnlockFileEx")
var procMove = k32.NewProc("MoveFileExW")
var procFree = k32.NewProc("GetDiskFreeSpaceExW")

func reparse(fi os.FileInfo) bool {
	s, ok := fi.Sys().(*syscall.Win32FileAttributeData)
	return ok && s.FileAttributes&0x400 != 0
}
func lockFile(f *os.File) error {
	var ov syscall.Overlapped
	r, _, e := procLock.Call(f.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(&ov)))
	if r == 0 {
		return e
	}
	return nil
}
func unlockFile(f *os.File) {
	var ov syscall.Overlapped
	procUnlock.Call(f.Fd(), 0, 1, 0, uintptr(unsafe.Pointer(&ov)))
}
func moveWin(a, b string, flags uintptr) error {
	x, e := syscall.UTF16PtrFromString(longPath(a))
	if e != nil {
		return e
	}
	y, e := syscall.UTF16PtrFromString(longPath(b))
	if e != nil {
		return e
	}
	r, _, e := procMove.Call(uintptr(unsafe.Pointer(x)), uintptr(unsafe.Pointer(y)), flags)
	if r == 0 {
		return e
	}
	return nil
}
func replaceFile(a, b string) error      { return moveWin(a, b, 9) }
func moveNoReplace(a, b string) error    { return moveWin(a, b, 8) }
func publishNoReplace(a, b string) error { return moveNoReplace(a, b) }
func syncDir(p string)                   {}
func freeSpace(p string) (uint64, error) {
	s, e := syscall.UTF16PtrFromString(longPath(p))
	if e != nil {
		return 0, e
	}
	var free, total, all uint64
	r, _, e := procFree.Call(uintptr(unsafe.Pointer(s)), uintptr(unsafe.Pointer(&free)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&all)))
	if r == 0 {
		return 0, e
	}
	return free, nil
}
func hideCommand(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func longPath(path string) string {
	path = filepath.Clean(path)
	if strings.HasPrefix(path, `\\?\`) {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + path[2:]
	}
	if filepath.IsAbs(path) {
		return `\\?\` + path
	}
	return path
}
