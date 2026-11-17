package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// ToolResolver preserves the Python precedence, including continuing past an
// invalid explicit candidate. No shell, recursive package scan or PATH mutation.
type ToolResolver struct {
	Config     Obj
	Dirs       []string
	Executable string
}

func toolName(stem string) string {
	if runtime.GOOS == "windows" {
		return stem + ".exe"
	}
	return stem
}
func toolCandidate(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	// Tool overrides and installer aliases are trusted executable selections,
	// not jailed gallery data: WinGet's normal file links must remain usable.
	if info, err := os.Stat(raw); err == nil && info.Mode().IsRegular() {
		absolute, err := filepath.Abs(raw)
		if err == nil {
			return absolute
		}
	}
	if found, err := exec.LookPath(raw); err == nil {
		return found
	}
	return ""
}
func (r ToolResolver) explicit(stem string) string {
	for _, value := range []string{os.Getenv("VIEWER_" + strings.ToUpper(stem)), str(r.Config[stem])} {
		if found := toolCandidate(value); found != "" {
			return found
		}
	}
	return ""
}
func (r ToolResolver) automatic(stem string) string {
	executable := r.Executable
	if executable == "" {
		executable, _ = os.Executable()
	}
	base := filepath.Dir(executable)
	dirs := append([]string{}, r.Dirs...)
	dirs = append(dirs, filepath.Join(base, "video-tools"), filepath.Join(filepath.Dir(base), "video-tools"), filepath.Join(base, "runtime", "win64"), filepath.Join(base, "runtime", "linux64"), base)
	for _, dir := range dirs {
		if found := toolCandidate(filepath.Join(dir, toolName(stem))); found != "" {
			return found
		}
	}
	if found, err := exec.LookPath(stem); err == nil {
		return found
	}
	if runtime.GOOS == "windows" {
		for _, pair := range [][2]string{{"LOCALAPPDATA", filepath.Join("Microsoft", "WinGet", "Links")}, {"ProgramFiles", filepath.Join("WinGet", "Links")}} {
			if base := os.Getenv(pair[0]); base != "" {
				if found := toolCandidate(filepath.Join(base, pair[1], toolName(stem))); found != "" {
					return found
				}
			}
		}
	}
	return ""
}
func (r ToolResolver) Resolve() (ffmpeg, ffprobe string) {
	ffmpeg = r.explicit("ffmpeg")
	if ffmpeg == "" {
		ffmpeg = r.automatic("ffmpeg")
	}
	ffprobe = r.explicit("ffprobe")
	if ffprobe == "" && ffmpeg != "" {
		ffprobe = toolCandidate(filepath.Join(filepath.Dir(ffmpeg), toolName("ffprobe")))
	}
	if ffprobe == "" {
		ffprobe = r.automatic("ffprobe")
	}
	return
}
func (s *Server) resolvedTools() (string, string) {
	s.cfgMu.Lock()
	config := Obj{"ffmpeg": s.cfg["ffmpeg"], "ffprobe": s.cfg["ffprobe"]}
	s.cfgMu.Unlock()
	return (ToolResolver{Config: config, Dirs: s.boot.ToolDirs}).Resolve()
}
