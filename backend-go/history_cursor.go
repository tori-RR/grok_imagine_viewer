package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

type historyCursor struct {
	Version  int    `json:"v"`
	Root     string `json:"root"`
	Snapshot int64  `json:"snapshot"`
	BeforeNS int64  `json:"ns"`
	BeforeID string `json:"id"`
	Expires  int64  `json:"expires"`
}

func (h *History) encodeHistoryPage(p historyCursor) string {
	data := mustJSON(p)
	mac := hmac.New(sha256.New, h.cursorKey)
	mac.Write(data)
	return base64.RawURLEncoding.EncodeToString(data) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (h *History) historyPage(ctx context.Context, root, cursor string) (historyCursor, error) {
	p := historyCursor{Version: 1, Root: hash([]byte(root)), Expires: time.Now().Add(time.Hour).Unix()}
	if cursor == "" {
		err := h.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(rowid),0) FROM runs WHERE root=?", root).Scan(&p.Snapshot)
		return p, err
	}
	invalid := func() (historyCursor, error) {
		return p, fail("invalid_history_cursor", "历史分页已失效，请刷新历史。", 409)
	}
	if len(cursor) > 2048 {
		return invalid()
	}
	parts := strings.Split(cursor, ".")
	if len(parts) != 2 {
		return invalid()
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return invalid()
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return invalid()
	}
	mac := hmac.New(sha256.New, h.cursorKey)
	mac.Write(data)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return invalid()
	}
	if json.Unmarshal(data, &p) != nil || p.Version != 1 || p.Root != hash([]byte(root)) || p.Snapshot < 1 || !stableID.MatchString(p.BeforeID) || p.Expires < time.Now().Unix() {
		return invalid()
	}
	return p, nil
}
