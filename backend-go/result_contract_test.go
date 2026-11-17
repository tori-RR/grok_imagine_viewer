package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedDownloadResultContract(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/download-result-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string
		Valid  bool
		Result Obj
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if (validateDownloadResult(c.Result) == nil) != c.Valid {
				t.Fatal("shared result contract mismatch", c.Result)
			}
		})
	}
}
