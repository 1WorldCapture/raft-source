package architecture_test

import (
	"go/ast"
	"testing"
)

// This is a STRUCTURAL contract for the specific wire APIs retired by the
// approved design, sections 6.3 and 7.1. Passing import-direction checks alone
// is insufficient when a presenter merely delegates encoding to the old
// domain encoder. The legacy wire declarations below must cease to be domain
// APIs, rather than survive as forwarding wrappers for migrated tests.
//
// This deliberately does not ban encoding/json in domains: canonical message
// digests, cursor signatures and Activity tokens remain domain algorithms.
// Executable protocol/reference/rollback tests, not this structural check,
// prove that moving the encoders preserves their actual wire behavior.
func TestDomainClientWireAPIsAreRetired(t *testing.T) {
	_, files := productionSources(t)
	types := map[string]map[string]bool{
		"message": {
			"MessageDTO": true, "SendResponseMessageDTO": true,
			"ReactionSummaryDTO": true, "MentionDTO": true,
			"AttachmentDTO": true, "ReactionViewerSnapshotDTO": true,
			"MessageWindowDTO": true, "ConversationContextDTO": true,
		},
		"channel": {"Wire": true},
	}
	functions := map[string]map[string]bool{
		"message": {
			"SocketMessageNew": true, "SocketMessageUpdated": true,
			"SocketMessageUpdatedInContext": true,
		},
		"channel": {"Wire": true},
		"readstate": {
			"ReadFrontierJSONTx": true, "DMReadStateTx": true,
			"ProjectPublication": true, "Wire": true,
		},
	}
	var violations []string
	for _, file := range files {
		if types[file.pkg] == nil && functions[file.pkg] == nil {
			continue
		}
		ast.Inspect(file.file, func(node ast.Node) bool {
			switch decl := node.(type) {
			case *ast.TypeSpec:
				if types[file.pkg][decl.Name.Name] {
					violations = append(violations, file.path+": domain declares client wire type "+decl.Name.Name)
				}
			case *ast.FuncDecl:
				if functions[file.pkg][decl.Name.Name] {
					violations = append(violations, file.path+": domain still owns retired client encoder/publisher "+decl.Name.Name)
				}
			}
			return true
		})
	}
	reportViolations(t, violations)
}
