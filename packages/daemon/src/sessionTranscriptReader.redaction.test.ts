import assert from "node:assert/strict";
import { test } from "vitest";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES } from "../../shared/src/test/diagnosticRedactionCredentialSamples.js";
import { redactTranscript } from "./sessionTranscriptReader.js";

// The transcript path must mask the SAME credential samples as every other diagnostic producer. Before the shared
// scrubber it had a private four-rule list that let a bare JWT (no `Bearer` prefix) through.
test("session transcript redaction masks every shared credential sample", () => {
  for (const { label, sample, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
    const out = redactTranscript(`{"text":${JSON.stringify(sample)}}`);
    assert.ok(!out.includes(mustNotContain), `${label} leaked through transcript redaction: ${out}`);
  }
});

test("session transcript redaction still drops whole URLs", () => {
  assert.equal(redactTranscript("see https://example.test/a?b=c now"), "see [url] now");
});
