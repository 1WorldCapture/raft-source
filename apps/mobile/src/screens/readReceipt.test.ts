import assert from "node:assert/strict";
import test from "node:test";
import { agentHasRead, dmReadByPeer, parsePeerReads } from "./readReceipt";

test("peer reads mark a DM message read and an agent mention read", () => {
  const peers = parsePeerReads({
    peerReadStates: [
      { peerKind: "agent", peerId: "cindy", maxReadSeq: 8 },
      { peerKind: "human", peerId: "me", maxReadSeq: 4 },
    ],
  });
  assert.equal(dmReadByPeer(peers ?? [], 8, "me"), true);
  assert.equal(dmReadByPeer(peers ?? [], 9, "me"), false);
  assert.equal(agentHasRead(peers ?? [], "cindy", 8), true);
  assert.equal(agentHasRead(peers ?? [], "cindy", 9), false);
});
