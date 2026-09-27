import { isTextPreviewCandidate } from "@botiverse/raft-shared";

export type AttachmentViewKind = "image" | "markdown" | "text" | "none";

function mimeBase(mimeType: string | null | undefined): string {
  return (mimeType ?? "").toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

/**
 * What the in-app viewer can open. Markdown matches the web classifier.
 * Images match the message row (an image MIME). Text uses the shared candidate list.
 */
export function viewKind(filename: string, mimeType?: string | null): AttachmentViewKind {
  const name = filename.toLowerCase();
  const mime = mimeBase(mimeType);
  if (name.endsWith(".md") || name.endsWith(".markdown") || mime === "text/markdown" || mime === "text/x-markdown") {
    return "markdown";
  }
  if (mime.startsWith("image/")) return "image";
  if (isTextPreviewCandidate(filename, mimeType)) return "text";
  return "none";
}
