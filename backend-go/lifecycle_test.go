package main

import (
	"bufio"
	"strconv"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackendProcessHelper(t *testing.T) {
	if os.Getenv("GIV_BACKEND_TEST_HELPER") != "1" {
		return
	}
	if err := serve(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}
func TestBootstrapIdentityAndEOFShutdown(t *testing.T) {
	base := t.TempDir()
	static := filepath.Join(base, "static")
	writeFixture(t, filepath.Join(static, "index.html"), []byte("fixture frontend"))
	configPath := filepath.Join(base, "config.json")
	writeFixture(t, configPath, []byte("{}"))
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "-test.run=^TestBackendProcessHelper$")
	cmd.Env = append(os.Environ(), "GIV_BACKEND_TEST_HELPER=1")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		input.Close()
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	b := Bootstrap{ProtocolVersion: 3, Secret: strings.Repeat("a", 64), Token: strings.Repeat("b", 64), Instance: strings.Repeat("c", 32), ServerPath: filepath.Join(base, "server.py"), Static: static, Config: configPath, Desktop: base, Language: "en", DownloadBindOnly: true}
	if err = json.NewEncoder(input).Encode(b); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(output).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	ready, err := decode(line)
	if err != nil {
		t.Fatal(err)
	}
	origin := str(ready["origin"])
	if !strings.HasPrefix(origin, "http://127.0.0.1:") {
		t.Fatal("not loopback", origin)
	}
	key, _ := hex.DecodeString(b.Secret)
	proof := hmac.New(sha256.New, key)
	fmt.Fprintf(proof, "%s\n%s\n%d", b.Instance, origin, cmd.Process.Pid)
	if str(ready["proof"]) != hex.EncodeToString(proof.Sum(nil)) {
		t.Fatal("invalid process identity")
	}
	client := &http.Client{Timeout: 3 * time.Second}
	challenge := bytesRepeat(0x44, 32)
	identityReq, _ := http.NewRequestWithContext(ctx, "GET", origin+"/api/identity", nil)
	identityReq.Header.Set("X-Viewer-Challenge", hex.EncodeToString(challenge))
	identityResp, err := client.Do(identityReq)
	if err != nil { t.Fatal("identity challenge request:", err) }
	identityBody, err := io.ReadAll(identityResp.Body)
	identityResp.Body.Close()
	if err != nil || identityResp.StatusCode != http.StatusOK { t.Fatal("identity challenge response:", identityResp.StatusCode, err) }
	var identity map[string]any
	if err = json.Unmarshal(identityBody, &identity); err != nil { t.Fatal(err) }
	portText := strings.TrimPrefix(origin, "http://127.0.0.1:")
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil { t.Fatal(err) }
	message := append([]byte("giv-identity-v3\x00"), challenge...)
	instanceID, _ := hex.DecodeString(b.Instance)
	message = append(message, instanceID...)
	message = append(message, byte(port>>8), byte(port))
	pid := uint32(cmd.Process.Pid)
	message = append(message, byte(pid>>24), byte(pid>>16), byte(pid>>8), byte(pid), 1)
	proofV3 := hmac.New(sha256.New, key)
	_, _ = proofV3.Write(message)
	if identity["app"] != "grok_imagine_viewer" || identity["protocolVersion"] != float64(3) || identity["challengeResponse"] != hex.EncodeToString(proofV3.Sum(nil)) {
		t.Fatalf("invalid Tauri v3 identity response: %#v", identity)
	}
	healthReq, _ := http.NewRequestWithContext(ctx, "GET", origin+"/api/health", nil)
	healthReq.Header.Set("X-Viewer-Session", b.Token)
	healthResp, err := client.Do(healthReq)
	if err != nil { t.Fatal("health endpoint request:", err) }
	healthBody, err := io.ReadAll(healthResp.Body)
	healthResp.Body.Close()
	if err != nil || healthResp.StatusCode != http.StatusOK { t.Fatal("health endpoint response:", healthResp.StatusCode, err) }
	var health map[string]any
	if err = json.Unmarshal(healthBody, &health); err != nil { t.Fatal(err) }
	if health["backend"] != "go" || health["protocolVersion"] != float64(3) || health["instanceId"] != b.Instance {
		t.Fatalf("unexpected health response: %#v", health)
	}
	unauthHealth, _ := http.NewRequestWithContext(ctx, "GET", origin+"/api/health", nil)
	unauthResp, err := client.Do(unauthHealth)
	if err != nil { t.Fatal("unauthenticated health request:", err) }
	unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusForbidden { t.Fatalf("unauthenticated health status = %d, want 403", unauthResp.StatusCode) }
	statusReq, _ := http.NewRequestWithContext(ctx, "GET", origin+"/api/download/status", nil)
	statusReq.Header.Set("X-Viewer-Session", b.Token)
	statusResp, err := client.Do(statusReq)
	if err != nil { t.Fatal("download status request:", err) }
	statusBody, err := io.ReadAll(statusResp.Body)
	statusResp.Body.Close()
	if err != nil || statusResp.StatusCode != http.StatusOK { t.Fatal("download status response:", statusResp.StatusCode, err) }
	var publicStatus map[string]any
	if err = json.Unmarshal(statusBody, &publicStatus); err != nil { t.Fatal(err) }
	if publicStatus["active"] != false || publicStatus["tickets"] != nil || publicStatus["result"] != nil { t.Fatalf("unexpected public download status: %#v", publicStatus) }
	unauthStatus, _ := http.NewRequestWithContext(ctx, "GET", origin+"/api/download/status", nil)
	unauthResp, err = client.Do(unauthStatus)
	if err != nil { t.Fatal("unauthenticated download status request:", err) }
	unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusForbidden { t.Fatalf("unauthenticated download status = %d, want 403", unauthResp.StatusCode) }
	req, _ := http.NewRequestWithContext(ctx, "GET", origin+"/", nil)
	req.Header.Set("X-Viewer-Session", b.Token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != 200 || string(body) != "fixture frontend" {
		t.Fatal("static frontend response", resp.StatusCode, err)
	}
	writeFixture(t, filepath.Join(static, "assets", "app.js"), []byte("window.__react_bundle__ = true;"))
	assetReq, _ := http.NewRequestWithContext(ctx, "GET", origin+"/static/assets/app.js", nil)
	assetReq.Header.Set("X-Viewer-Session", b.Token)
	assetResp, err := client.Do(assetReq)
	if err != nil { t.Fatal("static asset request:", err) }
	assetBody, err := io.ReadAll(assetResp.Body)
	assetResp.Body.Close()
	if err != nil || assetResp.StatusCode != http.StatusOK || string(assetBody) != "window.__react_bundle__ = true;" {
		t.Fatalf("static asset response: status=%d body=%q err=%v", assetResp.StatusCode, assetBody, err)
	}
	input.Close()
	if err = cmd.Wait(); err != nil {
		t.Fatal("EOF shutdown failed", err)
	}
}
