// These are explicitly approved STRUCTURAL architecture contracts. They do
// not prove protocol parity, transaction correctness, or security behavior;
// the executable backend, original-client and race suites remain mandatory.
package architecture_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const internalPrefix = "raft.local/server-go/internal/"

type productionFile struct {
	path    string
	pkg     string
	file    *ast.File
	imports map[string]string
}

func productionSources(t *testing.T) (string, []productionFile) {
	t.Helper()
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if content, err := os.ReadFile(filepath.Join(root, "go.mod")); err == nil && strings.Contains(string(content), "module raft.local/server-go") {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Fatal("cannot locate the server-go module root")
		}
		root = parent
	}
	var files []productionFile
	err = filepath.WalkDir(filepath.Join(root, "internal"), func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "testdata" || entry.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		file := productionFile{path: rel, pkg: strings.TrimPrefix(filepath.ToSlash(filepath.Dir(rel)), "internal/"), file: parsed, imports: map[string]string{}}
		for _, spec := range parsed.Imports {
			importPath, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			alias := filepath.Base(importPath)
			if spec.Name != nil {
				alias = spec.Name.Name
			}
			file.imports[alias] = importPath
		}
		files = append(files, file)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return root, files
}

func within(pkg, prefix string) bool { return pkg == prefix || strings.HasPrefix(pkg, prefix+"/") }

func reportViolations(t *testing.T, violations []string) {
	t.Helper()
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	limit := len(violations)
	if limit > 24 {
		limit = 24
	}
	for _, violation := range violations[:limit] {
		t.Log(violation)
	}
	t.Errorf("%d structural violations (showing %d); complete the approved architecture rather than exempting production paths", len(violations), limit)
}

func TestStabilizationRequiredProductionBoundaries(t *testing.T) {
	_, files := productionSources(t)
	packages := map[string]bool{}
	for _, file := range files {
		packages[file.pkg] = true
		if within(file.pkg, "transport/legacyweb") {
			t.Errorf("legacyweb still contains production source: %s", file.path)
		}
	}
	for _, required := range []string{
		"app", "application/messaging", "application/channelview", "application/realtime", "application/machinecontrol",
		"publication", "protocol/client", "transport/presenter", "transport/httpapi",
		"transport/httpapi/httpx", "transport/httpapi/authn", "transport/httpapi/humanapi",
		"transport/httpapi/agentapi", "transport/httpapi/computerapi", "transport/socketio/bridge",
		"transport/socketio/core", "transport/socketio/zishang", "transport/machinews",
	} {
		if !packages[required] {
			t.Errorf("required production boundary has no Go source: internal/%s", required)
		}
	}
}

func TestStabilizationDependencyDirection(t *testing.T) {
	_, files := productionSources(t)
	domains := map[string]bool{
		"auth": true, "workspace": true, "channel": true, "message": true, "readstate": true,
		"agent": true, "computer": true, "runtimecatalog": true,
	}
	businessHTTP := []string{"transport/httpapi/humanapi", "transport/httpapi/agentapi", "transport/httpapi/computerapi"}
	var violations []string
	for _, file := range files {
		for _, imported := range file.imports {
			dep := strings.TrimPrefix(imported, internalPrefix)
			local := strings.HasPrefix(imported, internalPrefix)
			bad := false
			if local && within(dep, "app") && !within(file.pkg, "app") {
				bad = true
			}
			if local && within(dep, "transport/legacyweb") {
				bad = true
			}
			if within(file.pkg, "application") {
				bad = bad || local && (within(dep, "transport") || within(dep, "protocol")) || strings.HasPrefix(imported, "github.com/zishang520/socket.io")
			}
			if domains[strings.Split(file.pkg, "/")[0]] && local {
				bad = bad || within(dep, "application") || within(dep, "transport") || within(dep, "protocol")
			}
			if within(file.pkg, "publication") {
				// The durable queue is intentionally only standard library plus
				// platform; it must not turn into the application event bus.
				if local {
					bad = bad || !(within(dep, "platform") || within(dep, "publication"))
				} else if strings.Contains(strings.Split(imported, "/")[0], ".") {
					bad = true
				}
			}
			if within(file.pkg, "protocol/client") {
				bad = bad || local && !within(dep, "protocol") || imported == "database/sql" || imported == "net/http"
			}
			if within(file.pkg, "transport/presenter") {
				bad = bad || imported == "database/sql" || imported == "net/http" || local && within(dep, "platform/db")
			}
			if within(file.pkg, "transport/httpapi") && file.pkg != "transport/httpapi" && local && dep == "transport/httpapi" {
				bad = true
			}
			for _, leaf := range businessHTTP {
				if within(file.pkg, leaf) && local {
					for _, sibling := range businessHTTP {
						bad = bad || sibling != leaf && within(dep, sibling)
					}
				}
			}
			if (within(file.pkg, "transport/socketio/core") || within(file.pkg, "transport/socketio/zishang") || file.pkg == "transport/socketio") && local && within(dep, "transport/socketio/bridge") {
				bad = true
			}
			if bad {
				violations = append(violations, file.path+" imports "+imported)
			}
		}
	}
	reportViolations(t, violations)
}

func TestStabilizationTransportAndCompositionDoNotExecuteSQL(t *testing.T) {
	_, files := productionSources(t)
	// Context-suffixed SQL executor calls and transaction helpers are not
	// application services. This rule deliberately excludes ordinary domain
	// methods such as Query/Read that can have legitimate non-SQL meanings.
	forbiddenCalls := map[string]bool{
		"ExecContext": true, "QueryContext": true, "QueryRowContext": true,
		"PrepareContext": true, "BeginTx": true, "WithWriteTx": true,
		"WithReadSnapshot": true, "PingContext": true,
	}
	var violations []string
	for _, file := range files {
		if !within(file.pkg, "app") && !within(file.pkg, "transport") {
			continue
		}
		ast.Inspect(file.file, func(node ast.Node) bool {
			if call, ok := node.(*ast.CallExpr); ok {
				if selected, ok := call.Fun.(*ast.SelectorExpr); ok {
					if forbiddenCalls[selected.Sel.Name] {
						violations = append(violations, file.path+": SQL/transaction call "+selected.Sel.Name)
					}
					// Store.DB() escapes the boundary even when transport never
					// names sql.DB: handing that raw executor back into a domain
					// query lets a handler pick its own snapshot. The composition
					// root may wire DB handles; transport must not obtain one.
					if within(file.pkg, "transport") && selected.Sel.Name == "DB" && len(call.Args) == 0 {
						violations = append(violations, file.path+": transport obtains raw Store.DB()")
					}
				}
			}
			if within(file.pkg, "transport") {
				if selected, ok := node.(*ast.SelectorExpr); ok {
					if name, ok := selected.X.(*ast.Ident); ok && file.imports[name.Name] == "database/sql" && (selected.Sel.Name == "DB" || selected.Sel.Name == "Tx" || selected.Sel.Name == "Conn") {
						violations = append(violations, file.path+": transport depends on raw sql."+selected.Sel.Name)
					}
				}
			}
			return true
		})
	}
	reportViolations(t, violations)
}

func TestStabilizationProductionNamesDescribeCapabilities(t *testing.T) {
	_, files := productionSources(t)
	phaseFile := regexp.MustCompile(`(?i)^m[0-9]+(?:_|\.go$)`)
	phaseName := regexp.MustCompile(`^(?:(?:build|assemble|new|register|Register|New|Build|Assemble))?[mM][0-9]+(?:[A-Z_]|$)`)
	oldSeams := map[string]bool{
		"SetThreadReplyReadHook": true, "HasThreadReplyReadHook": true,
		"SetWriteTx": true, "SetReadSnapshot": true, "SetValidateHuman": true, "SetEnqueue": true,
		"ReadstateRoutes": true, "listM3": true, "getM3": true,
	}
	var violations []string
	for _, file := range files {
		if phaseFile.MatchString(filepath.Base(file.path)) {
			violations = append(violations, file.path+": milestone-prefixed production filename")
		}
		seen := map[string]bool{}
		ast.Inspect(file.file, func(node ast.Node) bool {
			name, ok := node.(*ast.Ident)
			if ok && !seen[name.Name] && (phaseName.MatchString(name.Name) || oldSeams[name.Name]) {
				seen[name.Name] = true
				violations = append(violations, file.path+": retired milestone/seam identifier "+name.Name)
			}
			return true
		})
	}
	// Release metadata, historical migration triggers, comments, protocol
	// strings, model IDs and test/fixture names are intentionally not scanned.
	reportViolations(t, violations)
}
