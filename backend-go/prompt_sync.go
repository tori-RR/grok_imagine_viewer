package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxPromptTargets = 8192
const maxPromptBytes = 100000
const maxPromptUpdatesBytes = 4 << 20
const maxPromptTargetsBytes = 1536 << 10

// Binding is filled by Go only after matching a run-issued target. It is kept
// inside the immutable transaction manifest so recovery has the original exact
// card/member destination, never an asset-ID search across arbitrary groups.
type PromptBinding struct {
	Section string `json:"section"`
	Folder  string `json:"folder"`
	GroupID string `json:"groupId"`
	File    string `json:"file"`
}

type PromptUpdate struct {
	Token   string         `json:"token"`
	ID      string         `json:"id"`
	Conv    string         `json:"conv"`
	Prompt  string         `json:"prompt"`
	Binding *PromptBinding `json:"binding,omitempty"`
}

type promptTargetBinding struct {
	ID, Conv string
	Binding  PromptBinding
}

func validatePromptInput(manifest Obj) error {
	raw, present := manifest["promptUpdates"]
	if !present {
		return nil
	}
	updates, ok := raw.([]any)
	if !ok || len(updates) > maxPromptTargets {
		return errors.New("invalid_prompt_updates")
	}
	for _, raw := range updates {
		update := obj(raw)
		if len(update) != 4 || requireKeys(update, "token", "id", "conv", "prompt") != nil {
			return errors.New("invalid_prompt_update_fields")
		}
		for _, field := range []string{"token", "id", "conv", "prompt"} {
			if _, ok := update[field].(string); !ok {
				return errors.New("invalid_prompt_update_types")
			}
		}
	}
	return nil
}

func validatePromptUpdates(updates []PromptUpdate) error {
	if len(updates) > maxPromptTargets {
		return errors.New("prompt_update_limit")
	}
	seen := map[string]bool{}
	for _, update := range updates {
		if !tokenPattern.MatchString(update.Token) || seen[update.Token] || !stableID.MatchString(update.ID) || update.Conv != "" && !stableID.MatchString(update.Conv) || strings.TrimSpace(update.Prompt) == "" || len(update.Prompt) > maxPromptBytes {
			return errors.New("invalid_prompt_update")
		}
		seen[update.Token] = true
		if binding := update.Binding; binding != nil {
			if binding.Section != "combos" && binding.Section != "_other" || !safeName(binding.Folder) || !stableID.MatchString(binding.GroupID) || !safeName(binding.File) || mimeFor(binding.File) == "" || strings.TrimSuffix(binding.File, filepath.Ext(binding.File)) != update.ID {
				return errors.New("invalid_prompt_binding")
			}
		}
	}
	// Budget the external patch array, without Go-only journal bindings and
	// without Go's default HTML escaping (Rust/JS retain <, > and & as text).
	public := make([]Obj, 0, len(updates))
	for _, update := range updates {
		public = append(public, Obj{"token": update.Token, "id": update.ID, "conv": update.Conv, "prompt": update.Prompt})
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(public)
	if err != nil || encoded.Len()-1 > maxPromptUpdatesBytes {
		return errors.New("prompt_update_budget")
	}
	return nil
}

func (r *DownloadRun) promptTargetToken(user, id, conv string, binding PromptBinding) string {
	return promptTargetMAC(r.Token, user, id, conv, binding)
}

func promptTargetMAC(runToken, user, id, conv string, binding PromptBinding) string {
	mac := hmac.New(sha256.New, []byte(runToken))
	b, _ := json.Marshal([]string{user, id, conv, binding.Section, binding.Folder, binding.GroupID, binding.File})
	_, _ = mac.Write(b)
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

// No prompt, filename or local path crosses into the remote-origin script.
// First-use binding remains the existing download path; unbound libraries do
// not disclose local identities before the user/account relation is saved.
func (s *Server) promptTargets(ctx context.Context, p Obj) (Obj, error) {
	return s.promptTargetsWithBudget(ctx, p, 6*time.Second)
}

func (s *Server) promptTargetsWithBudget(ctx context.Context, p Obj, budget time.Duration) (Obj, error) {
	r, err := s.currentRun(p)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	if r.started || r.Result != nil || r.ctx.Err() != nil || s.stale(r.Snap) {
		r.mu.Unlock()
		return nil, changed()
	}
	if !sameRoot(str(p["root"]), r.Snap.Root) {
		r.mu.Unlock()
		return nil, changed()
	}
	runToken, issuedUser := r.Token, r.promptUser
	readCard := r.promptReadCard
	if readCard == nil {
		readCard = readJSON
	}
	r.mu.Unlock()
	user := str(p["userId"])
	if !stableID.MatchString(user) {
		return nil, fail("invalid_account", "账号校验失败。", 409)
	}
	meta, err := loadMeta(r.Snap.Root)
	if err != nil {
		return nil, err
	}
	bound := ""
	if raw, present := meta["grokUserId"]; present {
		var valid bool
		bound, valid = raw.(string)
		if !valid || bound != "" && !stableID.MatchString(bound) {
			return nil, fail("store_corrupt", "图库账号记录无效，原文件已保留。", 409)
		}
	}
	if bound == "" {
		return Obj{"ok": true, "targets": []any{}, "truncated": false}, nil
	}
	if bound != user {
		return nil, fail("account_mismatch", "图库账号不匹配。", 409)
	}
	if issuedUser != "" && issuedUser != user {
		return nil, fail("account_mismatch", "图库账号不匹配。", 409)
	}
	scanCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if scanCtx.Err() != nil {
		return Obj{"ok": true, "targets": []any{}, "truncated": true}, nil
	}
	indexPath, err := jailed(r.Snap.Root, "_index.json")
	if err != nil {
		return nil, err
	}
	index, err := readJSON(indexPath)
	if err != nil {
		return nil, err
	}
	index, err = readableIndex(index)
	if err != nil {
		return nil, err
	}
	targets := []any{}
	bindings := map[string]promptTargetBinding{}
	used, truncated := 128, false
	// Local-only exports in _other get the first bounded historical lookups.
	// This changes candidate priority only, never the stored index ordering.
scan:
	for _, field := range []string{"other", "combos"} {
		section := "combos"
		if field == "other" {
			section = "_other"
		}
		groups := rows(index[field])
		sort.SliceStable(groups, func(i, j int) bool { return str(groups[i]["folder"]) < str(groups[j]["folder"]) })
		for _, group := range groups {
			if r.ctx.Err() != nil {
				return nil, r.ctx.Err()
			}
			if scanCtx.Err() != nil {
				truncated = true
				break scan
			}
			folder, groupID := str(group["folder"]), str(group["id"])
			if !safeName(folder) || !stableID.MatchString(groupID) {
				continue
			}
			dir, err := jailed(r.Snap.Root, filepath.Join(section, folder))
			if err != nil {
				continue
			}
			cardPath, err := jailed(dir, "card.json")
			if err != nil {
				continue
			}
			card, err := readCard(cardPath)
			if err != nil || str(card["id"]) != groupID {
				continue
			}
			rawItems, ok := card["items"].([]any)
			if !ok {
				continue
			}
			counts := map[string]int{}
			for _, raw := range rawItems {
				if r.ctx.Err() != nil {
					return nil, r.ctx.Err()
				}
				if scanCtx.Err() != nil {
					truncated = true
					break scan
				}
				counts[str(obj(raw)["id"])]++
			}
			for _, raw := range rawItems {
				if r.ctx.Err() != nil {
					return nil, r.ctx.Err()
				}
				if scanCtx.Err() != nil {
					truncated = true
					break scan
				}
				item := obj(raw)
				id, conv, file := str(item["id"]), str(item["conversationId"]), str(item["file"])
				if !stableID.MatchString(id) || counts[id] != 1 || conv != "" && !stableID.MatchString(conv) || !safeName(file) || mimeFor(file) == "" || strings.TrimSuffix(file, filepath.Ext(file)) != id || str(item["status"]) == "trashed" || str(item["status"]) == "missing" {
					continue
				}
				if !promptMemberPresent(r.Snap.Root, dir, id, file) {
					continue
				}
				if len(targets) >= maxPromptTargets {
					truncated = true
					break scan
				}
				binding := PromptBinding{section, folder, groupID, file}
				tk := promptTargetMAC(runToken, user, id, conv, binding)
				if _, duplicate := bindings[tk]; duplicate {
					continue
				}
				target := Obj{"token": tk, "id": id, "conv": conv}
				encoded, _ := json.Marshal(target)
				if used+len(encoded)+1 > maxPromptTargetsBytes {
					truncated = true
					break scan
				}
				used += len(encoded) + 1
				targets = append(targets, target)
				bindings[tk] = promptTargetBinding{id, conv, binding}
				if len(targets) >= maxPromptTargets {
					truncated = true
					break scan
				}
			}
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started || r.Result != nil || r.ctx.Err() != nil || s.stale(r.Snap) || r.promptUser != "" && r.promptUser != user {
		return nil, changed()
	}
	r.promptUser, r.promptTargets = user, bindings
	return Obj{"ok": true, "targets": targets, "truncated": truncated}, nil
}

func promptMemberPresent(root, dir, id, file string) bool {
	tomb, err := jailed(root, filepath.Join(".trash", "by-id", id+".json"))
	if err != nil {
		return false
	}
	if _, err = os.Lstat(tomb); !os.IsNotExist(err) {
		return false
	}
	marker, err := jailed(dir, file+".trashed")
	if err != nil {
		return false
	}
	if _, err = os.Lstat(marker); !os.IsNotExist(err) {
		return false
	}
	media, err := jailed(dir, file)
	if err != nil {
		return false
	}
	_, err = regular(media)
	return err == nil
}

func (r *DownloadRun) bindPromptUpdates(m *Manifest, user string) error {
	if len(m.PromptUpdates) == 0 {
		return nil
	}
	if r.promptUser != user {
		return errors.New("unissued_prompt_targets")
	}
	for i := range m.PromptUpdates {
		update := &m.PromptUpdates[i]
		target, ok := r.promptTargets[update.Token]
		if !ok || update.Binding != nil || update.ID != target.ID || update.Conv != target.Conv {
			return errors.New("unissued_prompt_target")
		}
		binding := target.Binding
		update.Binding = &binding
	}
	return nil
}

// Every destination is preflighted before the first card write. Each write is
// atomic and idempotent; a crash leaves the immutable journal for exact replay.
func (r *DownloadRun) applyPromptUpdates(m Manifest) error {
	if len(m.PromptUpdates) == 0 {
		return nil
	}
	type cardPatch struct {
		path  string
		card  Obj
		dirty bool
	}
	cards := map[string]*cardPatch{}
	indexPath, err := jailed(r.Snap.Root, "_index.json")
	if err != nil {
		return err
	}
	index, err := readJSON(indexPath)
	if err != nil {
		return err
	}
	index, err = readableIndex(index)
	if err != nil {
		return err
	}
	for _, update := range m.PromptUpdates {
		binding := update.Binding
		if binding == nil || !hmac.Equal([]byte(update.Token), []byte(r.promptTargetToken(r.User, update.ID, update.Conv, *binding))) {
			return errors.New("prompt_target_owner_changed")
		}
		field := "combos"
		if binding.Section == "_other" {
			field = "other"
		}
		matched := 0
		for _, row := range rows(index[field]) {
			if str(row["id"]) == binding.GroupID && str(row["folder"]) == binding.Folder {
				matched++
			}
		}
		if matched != 1 {
			return errors.New("prompt_target_mapping_changed")
		}
		dir, err := jailed(r.Snap.Root, filepath.Join(binding.Section, binding.Folder))
		if err != nil {
			return err
		}
		path, err := jailed(dir, "card.json")
		if err != nil {
			return err
		}
		patch := cards[path]
		if patch == nil {
			card, err := readJSON(path)
			if err != nil || str(card["id"]) != binding.GroupID {
				return errors.New("prompt_target_card_changed")
			}
			if _, ok := card["items"].([]any); !ok {
				return errors.New("prompt_target_members_changed")
			}
			patch = &cardPatch{path: path, card: card}
			cards[path] = patch
		}
		var member Obj
		for _, item := range rows(patch.card["items"]) {
			if str(item["id"]) == update.ID {
				if member != nil {
					return errors.New("ambiguous_prompt_target")
				}
				member = item
			}
		}
		if member == nil || str(member["file"]) != binding.File || !promptConversationMatches(m, update, member) || str(member["status"]) == "trashed" || str(member["status"]) == "missing" || !promptMemberPresent(r.Snap.Root, dir, update.ID, binding.File) {
			return errors.New("prompt_target_member_changed")
		}
		if value, valid := member["prompt"].(string); !valid || value != update.Prompt {
			member["prompt"] = update.Prompt
			patch.dirty = true
		}
	}
	paths := make([]string, 0, len(cards))
	for path := range cards {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if !cards[path].dirty {
			continue
		}
		body, err := json.MarshalIndent(cards[path].card, "", "  ")
		if err != nil {
			return err
		}
		if err = atomicBytesGuarded(path, append(body, '\n'), func() error {
			if err := r.ctx.Err(); err != nil {
				return err
			}
			if r.s.stale(r.Snap) {
				return changed()
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

func promptConversationMatches(m Manifest, update PromptUpdate, member Obj) bool {
	current := str(member["conversationId"])
	if current == update.Conv {
		return true
	}
	if update.Conv != "" || update.Binding == nil {
		return false
	}
	// A normal publication may have filled an old card's missing conversation.
	// Accept only that same manifest's exact asset/file and mapped group; this
	// does not turn an arbitrary new conversation or ID copy into a target.
	conversations := map[string]bool{}
	for _, conversation := range m.Conversations {
		conversations[conversation.ID] = true
	}
	for _, asset := range m.Assets {
		if asset.ID != update.ID || asset.Conv != current || asset.ID+assetExt(asset) != update.Binding.File {
			continue
		}
		group := asset.Conv
		if group == "" {
			group = asset.RootConv
		}
		if !conversations[asset.Conv] && conversations[asset.RootConv] {
			group = asset.RootConv
		}
		if group == "" {
			group = asset.ID
		}
		if group == update.Binding.GroupID {
			return true
		}
	}
	return false
}

func (r *DownloadRun) confirmPromptAccount() error {
	r.mu.Lock()
	r.Phase = "verify_account"
	r.mu.Unlock()
	select {
	case user := <-r.authorize:
		if user != r.User {
			return errors.New("account_unverified")
		}
	case <-time.After(60 * time.Second):
		return errors.New("account_unverified")
	case <-r.ctx.Done():
		return r.ctx.Err()
	}
	return r.bind()
}

// This branch deliberately never calls media scan, layout/index publication or
// inbox cleanup. An empty remote list cannot clear or remap a local library.
func (r *DownloadRun) processPromptOnly(m Manifest) (bool, string) {
	if err := r.journal("media", m); err != nil {
		return false, "journal_failed"
	}
	if err := r.confirmPromptAccount(); err != nil {
		if err.Error() == "account_unverified" {
			return false, "account_unverified"
		}
		return false, downloadBindCode(err)
	}
	if err := r.journal("publishing", m); err != nil {
		return false, "journal_failed"
	}
	r.mu.Lock()
	r.Phase = "publishing"
	r.mu.Unlock()
	if err := r.applyPromptUpdates(m); err != nil {
		return false, "prompt_update_failed"
	}
	if err := r.retireTransaction(); err != nil {
		return true, "journal_cleanup_pending"
	}
	return true, ""
}
