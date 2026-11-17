package main

import (
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func validBootstrapJSON(t *testing.T) []byte {
	value := map[string]any{
		"instanceSecret": hex.EncodeToString(bytesRepeat(0xa1, 32)),
		"sessionToken": hex.EncodeToString(bytesRepeat(0x11, 32)),
		"instanceId": hex.EncodeToString(bytesRepeat(0xab, 16)),
		"protocolVersion": 3,
		"serverPath": filepath.Join(t.TempDir(), "server.py"),
		"downloadBindOnly": true,
		"staticDir": filepath.Clean(t.TempDir()),
		"configPath": filepath.Join(t.TempDir(), "config.json"),
		"desktop": t.TempDir(),
		"language": "en",
	}
	data, _ := json.Marshal(value)
	return data
}

func bytesRepeat(value byte, count int) []byte {
	result := make([]byte, count)
	for i := range result { result[i] = value }
	return result
}

func TestParseBootstrapAcceptsValidPayload(t *testing.T) {
	data := validBootstrapJSON(t)
	parsed, err := parseBootstrap(data)
	if err != nil { t.Fatalf("valid bootstrap rejected: %v", err) }
	if parsed.Language != "en" { t.Fatalf("unexpected language: %q", parsed.Language) }
}

func TestParseBootstrapRejectsUnknownFields(t *testing.T) {
	data := validBootstrapJSON(t)
	data = []byte(strings.TrimSuffix(string(data), "}"))
	data = append(data, []byte(`, "unexpected":"field"}`)...)
	if _, err := parseBootstrap(data); err == nil {
		t.Fatal("unknown field was accepted")
	}
}

func TestParseBootstrapRejectsMalformedIdentity(t *testing.T) {
	for _, mutate := range []func(map[string]any){
		func(v map[string]any) { v["instanceSecret"] = "not-hex" },
		func(v map[string]any) { v["sessionToken"] = hex.EncodeToString(make([]byte, 16)) },
		func(v map[string]any) { v["instanceId"] = hex.EncodeToString(make([]byte, 32)) },
		func(v map[string]any) { v["instanceId"] = strings.ToUpper(v["instanceId"].(string)) },
	} {
		var value map[string]any
		_ = json.Unmarshal(validBootstrapJSON(t), &value)
		mutate(value)
		data, _ := json.Marshal(value)
		if _, err := parseBootstrap(data); err == nil {
			t.Fatalf("malformed identity accepted: %s", data)
		}
	}
}

func TestParseBootstrapRejectsRelativePathsAndMissingContext(t *testing.T) {
	for _, field := range []string{"staticDir", "configPath", "desktop", "language"} {
		var value map[string]any
		_ = json.Unmarshal(validBootstrapJSON(t), &value)
		if field == "staticDir" || field == "configPath" { value[field] = "relative/path" } else { value[field] = "" }
		data, _ := json.Marshal(value)
		if _, err := parseBootstrap(data); err == nil {
			t.Fatalf("invalid %s accepted", field)
		}
	}
}
