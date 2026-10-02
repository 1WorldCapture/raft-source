// Types for the same test guard loaded directly by Node preloads.
export interface GuardAuditEvent {
  kind: "network" | "browser";
  target: string;
  pid: number;
  test: string;
}
export interface SideEffectGuard {
  root: string;
  checkProcess(command: string, args?: string[]): void;
  deny(kind: GuardAuditEvent["kind"], target: string): never;
  restore(): void;
}
export function installSideEffectGuard(root: string): SideEffectGuard;
export function auditEvents(root: string): GuardAuditEvent[];
