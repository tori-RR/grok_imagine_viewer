package main

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func promptSyncRun(t *testing.T, s *Server, root string) (Obj, []Obj) {
	t.Helper()
	w, reservation := call(t, s, http.MethodPost, "/internal/download/reserve", Obj{"root": root}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, reservation)
	}
	w, response := call(t, s, http.MethodPost, "/internal/download/prompt-targets", Obj{"runId": reservation["runId"], "root": root, "userId": "fixture-user"}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, response)
	}
	return reservation, rows(response["targets"])
}

func promptSyncBind(t *testing.T, root string) {
	t.Helper()
	m := defaultMeta()
	m["grokUserId"] = "fixture-user"
	jsonFixture(t, filepath.Join(root, ".viewer-meta.json"), m)
}

func promptSyncManifest(assets, updates []any) Obj {
	return Obj{"complete": true, "assets": assets, "conversations": []any{Obj{"id": "conversation-aaaaaaaa", "title": "原始标题"}}, "promptUpdates": updates}
}

func TestEmptyRemotePromptPreservesOnlySameMember(t *testing.T) {
	s, root := fixture(t)
	dir := filepath.Join(root, "combos", "0001_aaaaaaaa")
	card, _ := readJSON(filepath.Join(dir, "card.json"))
	items := rows(card["items"])
	items[0]["prompt"] = "keep this exact local prompt"
	items[1]["prompt"] = ""
	card["items"] = asAny(items)
	jsonFixture(t, filepath.Join(dir, "card.json"), card)
	assets := []any{}
	for _, item := range items {
		assets = append(assets, Obj{"id": item["id"], "key": item["id"], "mime": item["mime"], "conv": "conversation-aaaaaaaa", "prompt": " \n\t"})
	}
	w, reservation := call(t, s, http.MethodPost, "/internal/download/reserve", Obj{"root": root}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, reservation)
	}
	w, started := call(t, s, http.MethodPost, "/internal/download/start", Obj{"runId": reservation["runId"], "userId": "fixture-user", "manifest": promptSyncManifest(assets, []any{})}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, started)
	}
	if result := waitRun(t, s, "fixture-user", false); !yes(result["ok"]) {
		t.Fatal(result)
	}
	updated, _ := readJSON(filepath.Join(dir, "card.json"))
	got := rows(updated["items"])
	if str(got[0]["prompt"]) != "keep this exact local prompt" || str(got[1]["prompt"]) != "" {
		t.Fatal("empty remote metadata erased a local prompt or inherited a sibling", got)
	}
}

func TestHistoricalPromptUpdatesEmptyManifestPreservesLibrary(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	indexPath := filepath.Join(root, "_index.json")
	indexBefore, _ := os.ReadFile(indexPath)
	cardPath := filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json")
	cardBefore, _ := readJSON(cardPath)
	mediaPath := filepath.Join(root, "combos", "0001_aaaaaaaa", "asset-one.jpg")
	mediaBefore, _ := os.ReadFile(mediaPath)
	infoBefore, _ := os.Stat(mediaPath)
	reservation, targets := promptSyncRun(t, s, root)
	if len(targets) != 2 {
		t.Fatal(targets)
	}
	var target Obj
	for _, candidate := range targets {
		if str(candidate["id"]) == "asset-one" {
			target = candidate
		}
	}
	if target == nil || str(target["token"]) == "" || target["folder"] != nil || target["prompt"] != nil {
		t.Fatal("target leaked local paths or prompts", target)
	}
	patch := Obj{"token": target["token"], "id": target["id"], "conv": target["conv"], "prompt": "historical exact prompt"}
	w, started := call(t, s, http.MethodPost, "/internal/download/start", Obj{"runId": reservation["runId"], "userId": "fixture-user", "manifest": promptSyncManifest([]any{}, []any{patch})}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, started)
	}
	result := waitRun(t, s, "fixture-user", false)
	if !yes(result["ok"]) || !yes(result["published"]) || num(obj(result["counts"])["total"]) != 0 {
		t.Fatal(result)
	}
	indexAfter, _ := os.ReadFile(indexPath)
	mediaAfter, _ := os.ReadFile(mediaPath)
	infoAfter, _ := os.Stat(mediaPath)
	if !bytes.Equal(indexBefore, indexAfter) || !bytes.Equal(mediaBefore, mediaAfter) || !os.SameFile(infoBefore, infoAfter) || !infoBefore.ModTime().Equal(infoAfter.ModTime()) {
		t.Fatal("metadata-only sync touched index/media")
	}
	cardAfter, _ := readJSON(cardPath)
	rows(cardBefore["items"])[0]["prompt"] = patch["prompt"]
	if !bytes.Equal(mustJSON(cardBefore), mustJSON(cardAfter)) {
		t.Fatal("metadata-only sync changed unrelated card fields", cardAfter)
	}
	if exists(filepath.Join(root, "_inbox")) || exists(filepath.Join(root, "_state", ".giv-go-download.json")) {
		t.Fatal("metadata-only sync created media staging or left an unretired journal")
	}
	for _, endpoint := range []string{"/api/combo?section=combos&folder=0001_aaaaaaaa", "/api/flat"} {
		w, view := call(t, s, http.MethodGet, endpoint, nil, false)
		if w.Code != 200 {
			t.Fatal(w.Code, view)
		}
		found := false
		for _, item := range rows(view["items"]) {
			if str(item["id"]) == "asset-one" {
				found = str(item["prompt"]) == "historical exact prompt"
			}
		}
		if !found {
			t.Fatal("metadata patch did not reach API", endpoint, view)
		}
	}
}

func TestHistoricalPromptUpdatesRejectUnissuedOrAlteredTargets(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	reservation, targets := promptSyncRun(t, s, root)
	if len(targets) == 0 {
		t.Fatal(targets)
	}
	target := targets[0]
	good := Obj{"token": target["token"], "id": target["id"], "conv": target["conv"], "prompt": "historical exact prompt"}
	for _, change := range []Obj{{"token": "00000000000000000000000000000000"}, {"id": "not-local"}, {"conv": "wrong-conversation"}, {"folder": "0001_aaaaaaaa"}, {"binding": Obj{"section": "combos", "folder": "0001_aaaaaaaa", "groupId": "conversation-aaaaaaaa", "file": "asset-one.jpg"}}, {"prompt": ""}, {"prompt": " \n\t"}, {"prompt": strings.Repeat("猫", 33334)}} {
		patch := clone(good)
		for k, v := range change {
			patch[k] = v
		}
		w, response := call(t, s, http.MethodPost, "/internal/download/start", Obj{"runId": reservation["runId"], "userId": "fixture-user", "manifest": promptSyncManifest([]any{}, []any{patch})}, true)
		if w.Code != 409 {
			t.Fatal("unsafe metadata patch admitted", change, w.Code, response)
		}
	}
	w, response := call(t, s, http.MethodPost, "/internal/download/start", Obj{"runId": reservation["runId"], "userId": "fixture-user", "manifest": promptSyncManifest([]any{}, []any{good, good})}, true)
	if w.Code != 409 {
		t.Fatal("duplicate target admitted", w.Code, response)
	}
}

func TestHistoricalPromptUpdatesMixedSyncPreservesLocalOnlyGroups(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	firstPath := filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json")
	first, _ := readJSON(firstPath)
	firstItems := rows(first["items"])
	firstItems[1]["custom"] = Obj{"keep": true}
	jsonFixture(t, firstPath, first)
	other := Obj{"id": "absent-remote-group", "title": "local group title", "created": "2026-01-01", "unknownGroup": "keep", "items": []any{Obj{"id": "asset-one", "file": "asset-one.jpg", "mime": "image/jpeg", "status": "linked", "conversationId": "another-conversation", "prompt": "wrong duplicate prompt", "unknownItem": 17}}}
	otherPath := filepath.Join(root, "_other", "0001_local", "card.json")
	writeFixture(t, filepath.Join(filepath.Dir(otherPath), "asset-one.jpg"), jpg)
	jsonFixture(t, otherPath, other)
	index := Obj{"combos": []any{summary(first, "0001_aaaaaaaa")}, "other": []any{summary(other, "0001_local")}, "externalIndex": "keep"}
	jsonFixture(t, filepath.Join(root, "_index.json"), index)
	reservation, targets := promptSyncRun(t, s, root)
	if len(targets) != 3 {
		t.Fatal(targets)
	}
	if str(targets[0]["conv"]) != "another-conversation" {
		t.Fatal("_other historical targets must precede combos within optional budgets", targets)
	}
	updates := []any{}
	for _, target := range targets {
		updates = append(updates, Obj{"token": target["token"], "id": target["id"], "conv": target["conv"], "prompt": "history: " + str(target["id"]) + ":" + str(target["conv"])})
	}
	assets := []any{Obj{"id": "asset-one", "key": "asset-one", "mime": "image/jpeg", "conv": "conversation-aaaaaaaa", "prompt": ""}}
	w, started := call(t, s, http.MethodPost, "/internal/download/start", Obj{"runId": reservation["runId"], "userId": "fixture-user", "manifest": promptSyncManifest(assets, updates)}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, started)
	}
	result := waitRun(t, s, "fixture-user", false)
	if !yes(result["ok"]) || !yes(result["published"]) || num(obj(result["counts"])["total"]) != 0 {
		t.Fatal(result)
	}
	firstAfter, _ := readJSON(firstPath)
	if len(rows(firstAfter["items"])) != 2 || str(rows(firstAfter["items"])[0]["prompt"]) != "history: asset-one:" || str(rows(firstAfter["items"])[1]["prompt"]) != "history: asset-two:" || !yes(obj(rows(firstAfter["items"])[1]["custom"])["keep"]) {
		t.Fatal(firstAfter)
	}
	otherAfter, _ := readJSON(otherPath)
	rows(other["items"])[0]["prompt"] = "history: asset-one:another-conversation"
	if !bytes.Equal(mustJSON(otherAfter), mustJSON(other)) {
		t.Fatal("local-only entire group changed beyond exact prompt", otherAfter)
	}
	indexAfter, _ := readJSON(filepath.Join(root, "_index.json"))
	if len(rows(indexAfter["combos"])) != 1 || len(rows(indexAfter["other"])) != 1 || str(rows(indexAfter["other"])[0]["folder"]) != "0001_local" || str(indexAfter["externalIndex"]) != "keep" {
		t.Fatal(indexAfter)
	}
}

func TestPromptTargetsAreNativeAccountAndRootScoped(t *testing.T) {
	s, root := fixture(t)
	w, reservation := call(t, s, http.MethodPost, "/internal/download/reserve", Obj{"root": root}, true)
	if w.Code != 200 {
		t.Fatal(reservation)
	}
	p := Obj{"runId": reservation["runId"], "root": root, "userId": "fixture-user"}
	w, unbound := call(t, s, http.MethodPost, "/internal/download/prompt-targets", p, true)
	if w.Code != 200 || len(rows(unbound["targets"])) != 0 || exists(filepath.Join(root, ".viewer-meta.json")) {
		t.Fatal("unbound discovery wrote account data", w.Code, unbound)
	}
	jsonFixture(t, filepath.Join(root, ".viewer-meta.json"), Obj{"version": 2, "revision": 0, "items": Obj{}, "groups": Obj{}})
	w, unbound = call(t, s, http.MethodPost, "/internal/download/prompt-targets", p, true)
	if w.Code != 200 || len(rows(unbound["targets"])) != 0 {
		t.Fatal("missing account key must remain unbound", w.Code, unbound)
	}
	promptSyncBind(t, root)
	metaBefore, _ := os.ReadFile(filepath.Join(root, ".viewer-meta.json"))
	w, _ = call(t, s, http.MethodPost, "/internal/download/prompt-targets", p, false)
	if w.Code != 403 {
		t.Fatal("remote/gallery origin accessed native targets", w.Code)
	}
	for _, change := range []Obj{{"runId": 99999}, {"root": filepath.Dir(root)}, {"userId": "wrong-user"}} {
		bad := clone(p)
		for k, v := range change {
			bad[k] = v
		}
		w, out := call(t, s, http.MethodPost, "/internal/download/prompt-targets", bad, true)
		if w.Code != 409 {
			t.Fatal(change, w.Code, out)
		}
	}
	metaAfter, _ := os.ReadFile(filepath.Join(root, ".viewer-meta.json"))
	if !bytes.Equal(metaBefore, metaAfter) {
		t.Fatal("discovery changed saved account metadata")
	}
}

func TestPromptTargetsExcludeMissingTrashedAndAmbiguousMembers(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	path := filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json")
	card, _ := readJSON(path)
	items := rows(card["items"])
	items = append(items, clone(items[0]))
	card["items"] = asAny(items)
	jsonFixture(t, path, card)
	// Even a malformed tombstone is an exclusion, never permission to recover.
	writeFixture(t, filepath.Join(root, ".trash", "by-id", "asset-two.json"), []byte("{broken"))
	_, targets := promptSyncRun(t, s, root)
	if len(targets) != 0 {
		t.Fatal("trash/duplicate identities became historical targets", targets)
	}
}

func TestPromptTargetsSkipMismatchedIDAndFilename(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	path := filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json")
	card, _ := readJSON(path)
	rows(card["items"])[0]["file"] = "asset-two.jpg"
	jsonFixture(t, path, card)
	_, targets := promptSyncRun(t, s, root)
	if len(targets) != 1 || str(targets[0]["id"]) != "asset-two" {
		t.Fatal("mismatched card identity became a historical target", targets)
	}
}

func TestHistoricalPromptUpdatesRecoveryReusesOldRunScope(t *testing.T) {
	for _, phase := range []string{"media", "publishing"} {
		for _, mutation := range []string{"none", "already-applied", "wrong-account", "wrong-token", "changed-path", "removed-member"} {
			t.Run(phase+"/"+mutation, func(t *testing.T) {
				s, root := fixture(t)
				promptSyncBind(t, root)
				_, targets := promptSyncRun(t, s, root)
				old := s.run
				target := targets[0]
				m, err := validateManifest(promptSyncManifest([]any{}, []any{Obj{"token": target["token"], "id": target["id"], "conv": target["conv"], "prompt": "recovered historical prompt"}}))
				if err != nil {
					t.Fatal(err)
				}
				if err = old.bindPromptUpdates(&m, "fixture-user"); err != nil {
					t.Fatal(err)
				}
				old.User = "fixture-user"
				if mutation == "wrong-token" {
					m.PromptUpdates[0].Token = "00000000000000000000000000000000"
				}
				if mutation == "changed-path" {
					m.PromptUpdates[0].Binding.Folder = "different-local"
				}
				if err = old.journal(phase, m); err != nil {
					t.Fatal(err)
				}
				indexBefore, _ := os.ReadFile(filepath.Join(root, "_index.json"))
				cardPath := filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json")
				if mutation == "already-applied" {
					if err = old.applyPromptUpdates(m); err != nil {
						t.Fatal(err)
					}
				}
				if mutation == "removed-member" {
					card, _ := readJSON(cardPath)
					card["items"] = []any{}
					jsonFixture(t, cardPath, card)
				}
				before, _ := os.ReadFile(cardPath)
				old.finish(false, "interrupted")
				w, reserved := call(t, s, http.MethodPost, "/internal/download/reserve", Obj{"root": root}, true)
				if w.Code != 200 {
					t.Fatal(w.Code, reserved)
				}
				current := s.run
				current.User = "fixture-user"
				if current.Token == old.Token {
					t.Fatal("fixture did not create a new run scope")
				}
				if mutation == "wrong-account" {
					current.User = "another-user"
				}
				outcome, err := current.recoverPreviousOutcome()
				good := mutation == "none" || mutation == "already-applied"
				if good && (err != nil || !outcome.IndexPublished || !outcome.TransactionRetired) {
					t.Fatal(outcome, err)
				}
				if !good && err == nil {
					t.Fatal("unsafe recovery accepted", mutation, outcome)
				}
				after, _ := os.ReadFile(cardPath)
				if !good && !bytes.Equal(before, after) {
					t.Fatal("rejected recovery changed card")
				}
				if good {
					card, _ := readJSON(cardPath)
					if str(rows(card["items"])[0]["prompt"]) != "recovered historical prompt" {
						t.Fatal(card)
					}
				}
				indexAfter, _ := os.ReadFile(filepath.Join(root, "_index.json"))
				if !bytes.Equal(indexBefore, indexAfter) || exists(filepath.Join(root, "_inbox")) {
					t.Fatal("metadata recovery republished layout or staging")
				}
			})
		}
	}
}

func TestPromptTargetsKeepMoreThan1024Conversations(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	dir := filepath.Join(root, "combos", "0001_aaaaaaaa")
	card, _ := readJSON(filepath.Join(dir, "card.json"))
	items := []any{}
	for i := 0; i < 1100; i++ {
		id := fmt.Sprintf("synthetic-%04d", i)
		file := id + ".jpg"
		writeFixture(t, filepath.Join(dir, file), jpg)
		items = append(items, Obj{"id": id, "file": file, "mime": "image/jpeg", "status": "linked", "conversationId": fmt.Sprintf("conversation-%04d", i), "prompt": "old prompt"})
	}
	card["items"] = items
	jsonFixture(t, filepath.Join(dir, "card.json"), card)
	_, targets := promptSyncRun(t, s, root)
	if len(targets) != 1100 {
		t.Fatal("Go must not truncate conversations already fetched by the native side", len(targets))
	}
}

func TestHistoricalPromptUpdateBudgetIsPublicUTF8JSON(t *testing.T) {
	updates := []PromptUpdate{}
	for i := 0; i < 40; i++ {
		updates = append(updates, PromptUpdate{Token: fmt.Sprintf("%032x", i), ID: fmt.Sprintf("asset-%d", i), Conv: "", Prompt: strings.Repeat("<&>", 33333), Binding: &PromptBinding{Section: "combos", Folder: "0001_aaaaaaaa", GroupID: "conversation-aaaaaaaa", File: fmt.Sprintf("asset-%d.jpg", i)}})
	}
	if err := validatePromptUpdates(updates); err != nil {
		t.Fatal("HTML characters were overcharged or internal bindings counted", err)
	}
	for i := 40; i < 43; i++ {
		updates = append(updates, PromptUpdate{Token: fmt.Sprintf("%032x", i), ID: fmt.Sprintf("asset-%d", i), Prompt: strings.Repeat("a", 100000)})
	}
	if err := validatePromptUpdates(updates); err == nil {
		t.Fatal("over-budget public patches admitted")
	}
}

func TestHistoricalPromptUpdatesRequireFinalAccountReverification(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	reservation, targets := promptSyncRun(t, s, root)
	target := targets[0]
	cardPath := filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json")
	before, _ := os.ReadFile(cardPath)
	patch := Obj{"token": target["token"], "id": target["id"], "conv": target["conv"], "prompt": "must not publish under another account"}
	w, started := call(t, s, http.MethodPost, "/internal/download/start", Obj{"runId": reservation["runId"], "userId": "fixture-user", "manifest": promptSyncManifest([]any{}, []any{patch})}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, started)
	}
	result := waitRun(t, s, "different-user", false)
	if yes(result["ok"]) || yes(result["published"]) || str(result["code"]) != "account_unverified" {
		t.Fatal(result)
	}
	after, _ := os.ReadFile(cardPath)
	if !bytes.Equal(before, after) {
		t.Fatal("unverified account changed local prompt")
	}
}

func TestHistoricalPromptUpdatesMixedRecoveryAfterIndexPublication(t *testing.T) {
	s, root := fixture(t)
	promptSyncBind(t, root)
	_, targets := promptSyncRun(t, s, root)
	old := s.run
	updates := []any{}
	for _, target := range targets {
		updates = append(updates, Obj{"token": target["token"], "id": target["id"], "conv": target["conv"], "prompt": "recovered: " + str(target["id"])})
	}
	assets := []any{Obj{"id": "asset-one", "key": "asset-one", "mime": "image/jpeg", "conv": "conversation-aaaaaaaa", "prompt": ""}}
	m, err := validateManifest(promptSyncManifest(assets, updates))
	if err != nil {
		t.Fatal(err)
	}
	if err = old.bindPromptUpdates(&m, "fixture-user"); err != nil {
		t.Fatal(err)
	}
	old.User = "fixture-user"
	if err = old.journal("publishing", m); err != nil {
		t.Fatal(err)
	}
	existing, trashed, err := old.scanExisting(m)
	if err != nil {
		t.Fatal(err)
	}
	if err = old.publish(m, existing, trashed); err != nil {
		t.Fatal(err)
	}
	cardPath := filepath.Join(root, "combos", "0001_aaaaaaaa", "card.json")
	card, _ := readJSON(cardPath)
	if str(rows(card["items"])[0]["conversationId"]) != "conversation-aaaaaaaa" {
		t.Fatal("fixture did not fill the old missing conversation", card)
	}
	old.finish(false, "interrupted")
	w, reservation := call(t, s, http.MethodPost, "/internal/download/reserve", Obj{"root": root}, true)
	if w.Code != 200 {
		t.Fatal(w.Code, reservation)
	}
	current := s.run
	current.User = "fixture-user"
	outcome, err := current.recoverPreviousOutcome()
	if err != nil || !outcome.IndexPublished || !outcome.TransactionRetired {
		t.Fatal(outcome, err)
	}
	card, _ = readJSON(cardPath)
	if len(rows(card["items"])) != 2 {
		t.Fatal(card)
	}
	for _, item := range rows(card["items"]) {
		if str(item["prompt"]) != "recovered: "+str(item["id"]) {
			t.Fatal("mixed replay lost an exact local target", item)
		}
	}
}
