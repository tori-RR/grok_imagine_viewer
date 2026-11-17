package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type Obj map[string]any

func str(v any) string { s, _ := v.(string); return s }
func obj(v any) Obj {
	if o, ok := v.(Obj); ok {
		return o
	}
	o, _ := v.(map[string]any)
	if o == nil {
		return Obj{}
	}
	return Obj(o)
}
func arr(v any) []any {
	a, _ := v.([]any)
	if a == nil {
		return []any{}
	}
	return a
}
func rows(v any) []Obj {
	out := []Obj{}
	for _, v := range arr(v) {
		if o := obj(v); len(o) > 0 {
			out = append(out, o)
		}
	}
	return out
}
func num(v any) int64 {
	switch x := v.(type) {
	case json.Number:
		n, _ := x.Int64()
		return n
	case int:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	case uint64:
		if x <= 1<<63-1 {
			return int64(x)
		}
	}
	return 0
}
func realnum(v any) float64 {
	switch x := v.(type) {
	case json.Number:
		n, _ := x.Float64()
		return n
	case float64:
		return x
	default:
		return float64(num(v))
	}
}
func yes(v any) bool { b, _ := v.(bool); return b }

// Clone JSON-shaped data without serializing every cached card/member twice.
// Scalar values are immutable; every mutable container gets its own allocation.
func clone(o Obj) Obj {
	if o == nil {
		return nil
	}
	out := make(Obj, len(o))
	for k, v := range o {
		out[k] = cloneValue(v)
	}
	return out
}
func cloneValue(v any) any {
	switch x := v.(type) {
	case Obj:
		return clone(x)
	case map[string]any:
		return clone(Obj(x))
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = cloneValue(item)
		}
		return out
	case []Obj:
		return cloneRows(x)
	case []string:
		return append([]string(nil), x...)
	default:
		return v
	}
}
func cloneRows(in []Obj) []Obj {
	out := make([]Obj, 0, len(in))
	for _, o := range in {
		out = append(out, clone(o))
	}
	return out
}
func decode(b []byte) (Obj, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var o Obj
	if e := d.Decode(&o); e != nil {
		return nil, e
	}
	if o == nil {
		return nil, errors.New("expected JSON object")
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return nil, errors.New("extra JSON data")
	}
	return o, nil
}
func token() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func unique(v any) []any {
	out := []any{}
	seen := map[string]bool{}
	for _, v := range arr(v) {
		s := strings.TrimSpace(str(v))
		if s != "" && !seen[s] && len(s) <= 512 {
			out = append(out, s)
			seen[s] = true
		}
	}
	return out
}
func asAny(in []Obj) []any {
	out := make([]any, len(in))
	for i, x := range in {
		out[i] = x
	}
	return out
}
func safeName(n string) bool {
	if n == "" || n == "." || n == ".." || len(n) > 255 || !utf8.ValidString(n) || strings.ContainsAny(n, "<>:\"/\\|?*\x00") || strings.HasSuffix(n, ".") || strings.HasSuffix(n, " ") {
		return false
	}
	for _, r := range n {
		if r < 32 {
			return false
		}
	}
	s := strings.ToUpper(strings.Split(n, ".")[0])
	if s == "CON" || s == "PRN" || s == "AUX" || s == "NUL" || len(s) == 4 && (strings.HasPrefix(s, "COM") || strings.HasPrefix(s, "LPT")) && s[3] >= '1' && s[3] <= '9' {
		return false
	}
	return true
}
func contained(root, path string) bool {
	rel, e := filepath.Rel(root, path)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}
func canonical(path string) (string, error) {
	if !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		return "", errors.New("absolute path required")
	}
	path, e := filepath.EvalSymlinks(path)
	if e != nil {
		return "", e
	}
	fi, e := os.Stat(path)
	if e != nil || !fi.IsDir() {
		return "", errors.New("directory unavailable")
	}
	return filepath.Clean(path), nil
}
func sameRoot(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	x, e := os.Stat(a)
	y, f := os.Stat(b)
	return e == nil && f == nil && os.SameFile(x, y)
}

// Every nested component must be a plain entry. Missing suffixes are permitted
// for a write, but existing symlinks/reparse points are never traversed.
func jailed(root, rel string) (string, error) {
	if rel == "" || rel == "." {
		return root, nil
	}
	if filepath.IsAbs(rel) || strings.ContainsRune(rel, 0) {
		return "", errors.New("unsafe path")
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	p := root
	for _, part := range parts {
		if !safeName(part) {
			return "", errors.New("unsafe component")
		}
		p = filepath.Join(p, part)
		fi, e := os.Lstat(p)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return "", e
		}
		if fi.Mode()&os.ModeSymlink != 0 || reparse(fi) {
			return "", errors.New("linked entry refused")
		}
	}
	if !contained(root, p) {
		return "", errors.New("escaped root")
	}
	return p, nil
}
func regular(path string) (os.FileInfo, error) {
	fi, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !fi.Mode().IsRegular() || reparse(fi) {
		return nil, errors.New("not a plain file")
	}
	return fi, nil
}
func openRegular(path string) (*os.File, error) {
	fi, e := regular(path)
	if e != nil {
		return nil, e
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	now, e := f.Stat()
	if e != nil || !os.SameFile(fi, now) {
		f.Close()
		return nil, errors.New("file changed before open")
	}
	return f, nil
}
func readJSON(path string) (Obj, error) {
	f, e := openRegular(path)
	if e != nil {
		if os.IsNotExist(e) {
			return Obj{}, nil
		}
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 32<<20+1))
	if e != nil {
		return nil, e
	}
	if len(b) > 32<<20 {
		return nil, errors.New("JSON exceeds budget")
	}
	return decode(b)
}
func atomicJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return atomicBytes(path, append(b, '\n'))
}
func atomicBytes(path string, b []byte) error {
	return atomicBytesGuarded(path, b, nil)
}

func atomicBytesGuarded(path string, b []byte, beforeReplace func() error) error {
	if fi, e := os.Lstat(path); e == nil && (!fi.Mode().IsRegular() || reparse(fi)) {
		return errors.New("unsafe replacement")
	} else if e != nil && !os.IsNotExist(e) {
		return e
	}
	old, e := os.ReadFile(path)
	if e == nil && bytes.Equal(old, b) {
		if beforeReplace != nil {
			return beforeReplace()
		}
		return nil
	}
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".giv-write-*.part")
	if e != nil {
		return e
	}
	tmp := f.Name()
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(tmp)
		}
	}()
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	if beforeReplace != nil {
		if e = beforeReplace(); e != nil {
			return e
		}
	}
	moveErr := replaceFile(tmp, path)
	got, re := os.ReadFile(path)
	if re != nil || !bytes.Equal(got, b) {
		keep = true // Preserve our durable temporary on uncertain filesystem outcomes.
		if moveErr != nil {
			return moveErr
		}
		return errors.New("atomic write readback mismatch")
	}
	syncDir(filepath.Dir(path))
	return nil
}
func fingerprint(path string) (Obj, error) {
	f, e := openRegular(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	before, e := f.Stat()
	if e != nil {
		return nil, e
	}
	h := sha256.New()
	n, e := io.Copy(h, io.LimitReader(f, before.Size()+1))
	if e != nil {
		return nil, e
	}
	after, e := f.Stat()
	if e != nil || n != before.Size() || after.Size() != before.Size() || after.ModTime() != before.ModTime() {
		return nil, errors.New("file changed while hashing")
	}
	return Obj{"size": n, "mtimeNs": before.ModTime().UnixNano(), "hash": hex.EncodeToString(h.Sum(nil))}, nil
}
func equalJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}
func unchanged(path string, fp Obj) bool {
	now, e := fingerprint(path)
	return e == nil && str(now["hash"]) == str(fp["hash"]) && num(now["size"]) == num(fp["size"])
}
func copyFileChecked(src, dst string) error {
	in, e := openRegular(src)
	if e != nil {
		return e
	}
	defer in.Close()
	before, e := in.Stat()
	if e != nil {
		return e
	}
	out, e := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	ok := false
	defer func() {
		out.Close()
		if !ok {
			os.Remove(dst)
		}
	}()
	n, e := io.CopyBuffer(out, io.LimitReader(in, before.Size()+1), make([]byte, 1<<20))
	if e != nil {
		return e
	}
	after, e := in.Stat()
	if e != nil || n != before.Size() || before.Size() != after.Size() || before.ModTime() != after.ModTime() {
		return errors.New("copy source changed")
	}
	if e = out.Sync(); e != nil {
		return e
	}
	if e = out.Close(); e != nil {
		return e
	}
	ok = true
	return nil
}
func requireKeys(o Obj, allowed ...string) error {
	set := map[string]bool{}
	for _, k := range allowed {
		set[k] = true
	}
	for k := range o {
		if !set[k] {
			return fmt.Errorf("unsupported field %s", k)
		}
	}
	return nil
}
func numeric(v any) bool {
	switch x := v.(type) {
	case json.Number:
		_, e := x.Int64()
		return e == nil
	case int, int64, uint64:
		return true
	case float64:
		return float64(int64(x)) == x
	}
	return false
}
