import { useEffect, useState } from "react";

export type MembersSurface = "office" | "list";

const listeners = new Set<() => void>();

function storageKey(userId: string): string {
  return `raft.members.surface.${userId}`;
}

export function readMembersSurface(userId: string | null): MembersSurface {
  if (!userId || typeof localStorage === "undefined") return "office";
  return localStorage.getItem(storageKey(userId)) === "list" ? "list" : "office";
}

export function writeMembersSurface(userId: string | null, surface: MembersSurface): void {
  if (userId && typeof localStorage !== "undefined") {
    localStorage.setItem(storageKey(userId), surface);
  }
  for (const listener of listeners) listener();
}

export function useMembersSurface(userId: string | null): MembersSurface {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const sync = () => setRevision((value) => value + 1);
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return readMembersSurface(revision >= 0 ? userId : null);
}
