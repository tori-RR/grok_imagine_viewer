package main

import "errors"

func validateDownloadResult(result Obj) error {
	r, err := decode(mustJSON(result))
	if err != nil {
		return err
	}
	if num(r["resultVersion"]) != 1 {
		return errors.New("invalid_result_version")
	}
	switch str(r["historyState"]) {
	case "persisted", "pending", "unavailable", "not_applicable":
	default:
		return errors.New("invalid_history_state")
	}
	warnings, ok := r["warnings"].([]any)
	if !ok {
		return errors.New("missing_warnings")
	}
	for _, warning := range warnings {
		if str(warning) != "history_persistence_pending" {
			return errors.New("invalid_warning")
		}
	}
	for _, key := range []string{"ok", "stopped", "published"} {
		if _, ok := r[key].(bool); !ok {
			return errors.New("missing_result_flag")
		}
	}
	for _, key := range []string{"total", "attempted", "succeeded", "failed", "skipped"} {
		v := obj(r["counts"])[key]
		if !numeric(v) || num(v) < 0 {
			return errors.New("invalid_result_counts")
		}
	}
	return nil
}
