package architecture_test

import (
	"go/ast"
	"reflect"
	"strconv"
	"testing"
)

// The three client-facing application packages return semantic facts and
// notifications. Moving a RawMessage, json-tagged DTO or socket encoder out
// of app/ into application/ is NOT the approved terminal separation. Internal
// cursor/digest/canonical JSON algorithms inside the owning domain packages
// are deliberately outside this rule, as are opaque Daemon command frames.
func TestClientWireSerializationIsNotOwnedByApplication(t *testing.T) {
	_, files := productionSources(t)
	oldWireCalls := map[string]bool{
		"ReadFrontierJSONTx": true, "DMReadStateTx": true,
		"SocketMessageNew": true, "SocketMessageUpdated": true,
		"SocketMessageUpdatedInContext": true,
	}
	jsonOutput := map[string]bool{
		"RawMessage": true, "Marshal": true, "MarshalIndent": true, "NewEncoder": true,
	}
	var violations []string
	for _, file := range files {
		if !within(file.pkg, "application/channelview") && !within(file.pkg, "application/messaging") && !within(file.pkg, "application/realtime") {
			continue
		}
		ast.Inspect(file.file, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.Field:
				if value.Tag == nil {
					break
				}
				quoted, err := strconv.Unquote(value.Tag.Value)
				if err != nil {
					t.Errorf("%s: invalid Go struct tag: %v", file.path, err)
					break
				}
				if _, encoded := reflect.StructTag(quoted).Lookup("json"); encoded {
					violations = append(violations, file.path+": application field owns a client JSON tag")
				}
			case *ast.SelectorExpr:
				if pkg, ok := value.X.(*ast.Ident); ok && file.imports[pkg.Name] == "encoding/json" && jsonOutput[value.Sel.Name] {
					violations = append(violations, file.path+": application owns JSON output "+value.Sel.Name)
				}
			case *ast.CallExpr:
				if called, ok := value.Fun.(*ast.SelectorExpr); ok && oldWireCalls[called.Sel.Name] {
					violations = append(violations, file.path+": application invokes old client-wire encoder "+called.Sel.Name)
				}
			}
			return true
		})
	}
	reportViolations(t, violations)
}
