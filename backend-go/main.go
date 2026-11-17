package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"strings"
	"time"
)

type Bootstrap struct {
	ProtocolVersion uint8    `json:"protocolVersion"`
	Secret          string   `json:"instanceSecret"`
	Token           string   `json:"sessionToken"`
	Instance        string   `json:"instanceId"`
	ServerPath      string   `json:"serverPath"`
	Static          string   `json:"staticDir"`
	Config          string   `json:"configPath"`
	Desktop         string   `json:"desktop"`
	Language        string   `json:"language"`
	Places          []Obj    `json:"places"`
	Root            string   `json:"root"`
	ToolDirs        []string `json:"toolDirs"`
	DownloadBindOnly bool   `json:"downloadBindOnly"`
}


// parseBootstrap validates the complete sidecar handshake before any service
// state or filesystem path is initialized. Unknown fields are rejected so a
// version mismatch cannot silently weaken the desktop/backend contract.
func parseBootstrap(data []byte) (Bootstrap, error) {
	var b Bootstrap
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&b); err != nil {
		return Bootstrap{}, fmt.Errorf("invalid bootstrap JSON: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return Bootstrap{}, fmt.Errorf("invalid bootstrap: trailing data")
	}
	for name, value := range map[string]string{"instanceSecret": b.Secret, "sessionToken": b.Token} {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) != 32 || strings.ToLower(value) != value {
			return Bootstrap{}, fmt.Errorf("invalid bootstrap %s", name)
		}
	}
	instance, err := hex.DecodeString(b.Instance)
	if err != nil || len(instance) != 16 || strings.ToLower(b.Instance) != b.Instance {
		return Bootstrap{}, fmt.Errorf("invalid bootstrap instanceId")
	}
	if b.ProtocolVersion != 3 {
		return Bootstrap{}, fmt.Errorf("unsupported bootstrap protocol")
	}
	if !filepath.IsAbs(b.ServerPath) || !filepath.IsAbs(b.Static) || !filepath.IsAbs(b.Config) {
		return Bootstrap{}, fmt.Errorf("invalid bootstrap paths")
	}
	if !b.DownloadBindOnly {
		return Bootstrap{}, fmt.Errorf("desktop download binding mode is required")
	}
	if b.Desktop == "" || b.Language == "" {
		return Bootstrap{}, fmt.Errorf("invalid bootstrap application context")
	}
	return b, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("giv-go 0.4.0-experimental.1")
		return
	}
	if e := serve(); e != nil {
		fmt.Fprintln(os.Stderr, "Go backend startup failed:", e)
		os.Exit(1)
	}
}
func serve() error {
	reader := bufio.NewReaderSize(os.Stdin, 65536)
	line, e := reader.ReadSlice('\n')
	if e != nil || len(line) > 65535 {
		return fmt.Errorf("invalid bootstrap")
	}
	b, e := parseBootstrap(line)
	if e != nil {
		return e
	}
	appToolDirs = append([]string{}, b.ToolDirs...)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() { io.Copy(io.Discard, reader); cancel() }()
	s, e := NewServer(ctx, b)
	if e != nil {
		return e
	}
	defer s.close()
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return e
	}
	defer listener.Close()
	s.origin = "http://" + listener.Addr().String()
	s.cookie = "GIV_SESSION_" + fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
	hs := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, ReadTimeout: 3 * time.Minute, MaxHeaderBytes: 16 << 10}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		s.stopDownloads()
		c, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		if err := hs.Shutdown(c); err != nil {
			_ = hs.Close()
		}
		listener.Close()
	}()
	if e = s.restoreSelectedRoot(); e != nil {
		return e
	}
	key, _ := hex.DecodeString(b.Secret)
	h := hmac.New(sha256.New, key)
	fmt.Fprintf(h, "%s\n%s\n%d", b.Instance, s.origin, os.Getpid())
	json.NewEncoder(os.Stdout).Encode(Obj{
		"app": "giv-go",
		"origin": s.origin,
		"pid": os.Getpid(),
		"instance": b.Instance,
		"proof": hex.EncodeToString(h.Sum(nil)),
		"cookie": s.cookie,
	})
	e = hs.Serve(listener)
	cancel()
	<-shutdownDone
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
