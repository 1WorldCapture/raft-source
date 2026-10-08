module spike.local/m4-socket

go 1.26.0

// Reference only: the parent-owned runner tests/acceptance/m4-socket-poc.mjs
// writes its own go.mod in an isolated temporary directory (it currently
// declares `go 1.25`; the candidate requires go >= 1.26.0, so that
// declaration must be raised before the runner compiles). The verified
// candidate is:
//
//   github.com/zishang520/socket.io/servers/socket/v3 v3.0.6 (Go 1.26.0)
//
// with sibling modules servers/engine/v3, parsers/{socket,engine}/v3 and
// the root github.com/zishang520/socket.io/v3, all pinned at v3.0.6.
require github.com/zishang520/socket.io/servers/socket/v3 v3.0.6
