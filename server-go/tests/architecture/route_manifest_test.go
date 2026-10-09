package architecture_test

import (
	"go/ast"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"raft.local/server-go/internal/transport/httpapi"
)

// The approved route inventory is an audit of the actual HTTP surface, not a
// second routing mechanism. This STRUCTURAL check cross-checks every literal
// ServeMux registration and its owning leaf; authenticated HTTP/rollback
// suites independently prove middleware order and externally visible errors.
// Dispatcher children need their own policy inventory in addition to the
// real mounted dispatcher; a fictional catch-all cannot replace real mounts.
func TestHTTPRouteManifestCoversActualMounts(t *testing.T) {
	_, files := productionSources(t)
	type mount struct{ pattern, owner, source string }
	var mounts []mount
	for _, file := range files {
		if !within(file.pkg, "transport/httpapi") {
			continue
		}
		ast.Inspect(file.file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) < 2 {
				return true
			}
			selected, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (selected.Sel.Name != "Handle" && selected.Sel.Name != "HandleFunc") {
				return true
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok {
				return true // computed families remain explicit inventory entries
			}
			pattern, err := strconv.Unquote(literal.Value)
			if err != nil || !strings.Contains(pattern, "/") {
				return true
			}
			owner := strings.TrimPrefix(file.pkg, "transport/httpapi/")
			if file.pkg == "transport/httpapi" {
				owner = "httpapi"
			}
			mounts = append(mounts, mount{pattern, owner, file.path})
			return true
		})
	}
	if len(mounts) == 0 {
		t.Fatal("no real registrations found; the architecture inventory check cannot be vacuous")
	}

	inventory := map[string][]string{}
	for _, entry := range httpapi.Manifest() {
		pattern := entry.Pattern
		if entry.Method != "*" && entry.Method != "" {
			pattern = entry.Method + " " + pattern
		}
		inventory[pattern] = append(inventory[pattern], entry.Owner)
	}
	var missing []string
	for _, actual := range mounts {
		owners, exists := inventory[actual.pattern]
		if !exists {
			missing = append(missing, actual.pattern+" ("+actual.source+")")
			continue
		}
		// Assembly-only mounts (avatars, Socket.IO and daemon) are allowed to
		// name the leaf that implements them, rather than "httpapi" itself.
		if actual.owner != "httpapi" {
			found := false
			for _, owner := range owners {
				found = found || owner == actual.owner
			}
			if !found {
				t.Errorf("manifest assigns %s to %v; its real registration is owned by %s (%s)", actual.pattern, owners, actual.owner, actual.source)
			}
		}
	}
	sort.Strings(missing)
	for _, pattern := range missing {
		t.Errorf("actual HTTP registration missing from Manifest: %s", pattern)
	}
}

// Every route must explain its original authentication level, scope,
// rate-limiter family and capability state. "human" alone loses the crucial
// Require vs RequireVerifiedProfileComplete distinction. These policy fields
// are descriptive and must never be used as a replacement authorization gate.
func TestHTTPRouteManifestRecordsPolicyDimensions(t *testing.T) {
	entries := httpapi.Manifest()
	if len(entries) == 0 {
		t.Fatal("route manifest is empty")
	}
	for _, entry := range entries {
		if strings.Contains(entry.Pattern, "*") {
			t.Errorf("%s %s uses an invented wildcard approximation; record real ServeMux patterns and dispatcher child patterns instead", entry.Method, entry.Pattern)
		}
	}
	typ := reflect.TypeOf(entries).Elem()
	for _, name := range []string{"Gate", "Scope", "RateLimit", "Capability"} {
		field, ok := typ.FieldByName(name)
		if !ok || field.Type.Kind() != reflect.String {
			t.Errorf("route manifest must declare string %s metadata; coarse identity/wildcard entries cannot describe the approved route policy", name)
			continue
		}
		for _, entry := range entries {
			value := reflect.ValueOf(entry).FieldByIndex(field.Index).String()
			if value == "" {
				t.Errorf("%s %s has no %s policy; use an explicit none/public/not-applicable value when appropriate", entry.Method, entry.Pattern, name)
			}
		}
	}
}
