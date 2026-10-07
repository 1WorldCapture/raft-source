// Task #7 (private deployment, phase 2): email link neutralization. Private
// deployments render no official links (docs / community / mobile CTA /
// unconfigured privacy), official deployments stay byte-stable.
import assert from "node:assert/strict";
import { afterAll, describe, test } from "vitest";

import {
  renderFeedbackReportReceiptEmailHtml,
  sendMobileAppDownloadEmail,
} from "./emailService.js";

const prevMode = process.env.RAFT_DEPLOYMENT_MODE;
const prevDocs = process.env.RAFT_PUBLIC_DOCS_URL;
const prevCommunity = process.env.FEEDBACK_RECEIPT_COMMUNITY_URL;

afterAll(() => {
  for (const [prev, key] of [
    [prevMode, "RAFT_DEPLOYMENT_MODE"],
    [prevDocs, "RAFT_PUBLIC_DOCS_URL"],
    [prevCommunity, "FEEDBACK_RECEIPT_COMMUNITY_URL"],
  ] as const) {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
});

describe("email link neutralization (task #7)", () => {
  test("official deployment keeps the community link (byte-stable default)", () => {
    delete process.env.RAFT_DEPLOYMENT_MODE;
    delete process.env.FEEDBACK_RECEIPT_COMMUNITY_URL;
    const html = renderFeedbackReportReceiptEmailHtml({ recipientName: "Tester" });
    assert.ok(html.includes("app.raft.build/join"), "official community link stays");
  });

  test("private deployment hides the community link entirely", () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    delete process.env.FEEDBACK_RECEIPT_COMMUNITY_URL;
    const html = renderFeedbackReportReceiptEmailHtml({ recipientName: "Tester" });
    assert.ok(!html.includes("app.raft.build"), "no official link in private email");
    assert.ok(!html.includes("Join the Raft community"), "no dead CTA either");
  });

  test("private deployment swaps the community link for the configured URL", () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    process.env.FEEDBACK_RECEIPT_COMMUNITY_URL = "https://community.internal.example";
    const html = renderFeedbackReportReceiptEmailHtml({ recipientName: "Tester" });
    assert.ok(html.includes("https://community.internal.example"));
    assert.ok(!html.includes("app.raft.build"));
  });

  test("private deployment never sends the official mobile-app journey email", async () => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
    const result = await sendMobileAppDownloadEmail("user@example.test");
    assert.equal(result, null);
  });
});
