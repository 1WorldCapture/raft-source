export function embeddedComputerVersions(): { computer: string; daemon: string; cli: string };
export function embeddedComputerVersionDefines(): Record<"__RAFT_COMPUTER_VERSION__" | "__RAFT_DAEMON_VERSION__" | "__RAFT_CLI_VERSION__", string>;
