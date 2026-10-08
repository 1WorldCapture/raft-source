// Package buildinfo exposes the identity compiled into THIS process. It never
// shells out to git at request time: a running stale binary must not describe
// the newly edited working tree as if it had loaded it.
package buildinfo

import (
	"encoding/json"
	"io"
	"net/http"
	"runtime"
	"runtime/debug"
)

const Stage = "m3"

// BuildTime is populated by the build target. Direct go run/build without
// ldflags intentionally reports unknown, not the current request/start time.
var BuildTime = "unknown"

type Info struct {
	Stage      string `json:"stage"`
	Revision   string `json:"revision"`
	Modified   bool   `json:"modified"`
	CommitTime string `json:"commitTime"`
	BuildTime  string `json:"buildTime"`
	GoVersion  string `json:"goVersion"`
}

func Current() Info {
	info := Info{Stage: Stage, Revision: "unknown", CommitTime: "unknown", BuildTime: BuildTime, GoVersion: runtime.Version()}
	if embedded, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range embedded.Settings {
			switch setting.Key {
			case "vcs.revision":
				info.Revision = setting.Value
			case "vcs.time":
				info.CommitTime = setting.Value
			case "vcs.modified":
				info.Modified = setting.Value == "true"
			}
		}
	}
	return info
}

func Write(out io.Writer) error { return json.NewEncoder(out).Encode(Current()) }

// Handler supplies an operator-visible endpoint, independent of API feature
// compatibility. Only public build metadata is emitted (no paths or config).
func Handler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = Write(w)
}

func Headers(next http.Handler) http.Handler {
	info := Current()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Raft-Go-Stage", info.Stage)
		w.Header().Set("X-Raft-Go-Revision", info.Revision)
		w.Header().Set("X-Raft-Go-Build-Time", info.BuildTime)
		next.ServeHTTP(w, r)
	})
}
