package delivery

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
)

// newTokenID mints a random uuid-formatted identifier (the same shape the
// agent module uses for launch ids). Nothing here is derived from workspace
// or agent identity.
func newTokenID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

// digestClaimBatch canonicalizes an issued batch into the SHA-256 digest
// persisted on agent_delivery_claims. Digesting workspace and agent binds
// that internal receipt to its principal. Ack does not require the client
// to resubmit this exact digest: the wire ack is the authenticated
// intersection of seqs and notice ids. A replay from another agent or
// workspace still cannot match this row.
func digestClaimBatch(workspaceID, agentID string, seqs []int64, messageIDs []string) string {
	sortedSeqs := append([]int64(nil), seqs...)
	sort.Slice(sortedSeqs, func(i, j int) bool { return sortedSeqs[i] < sortedSeqs[j] })
	sortedIDs := append([]string(nil), messageIDs...)
	sort.Strings(sortedIDs)
	h := sha256.New()
	fmt.Fprintf(h, "raft-claim-v1|%s|%s|", workspaceID, agentID)
	for _, s := range sortedSeqs {
		fmt.Fprintf(h, "s%d", s)
	}
	h.Write([]byte{'|'})
	for _, id := range sortedIDs {
		fmt.Fprintf(h, "m%s", id)
	}
	return hex.EncodeToString(h.Sum(nil))
}
