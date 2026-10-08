// Package computer owns the M3B admission slice: the device-code user login
// grant, Computer (sk_computer_*) attach/revoke, legacy machine
// (sk_machine_*) creation/key rotation/roster reads, and the machine-plane
// Authenticate seam consumed by the legacy WebSocket transport.
//
// Behavior is ported line-by-line from the TS sources listed in
// docs/m3-computer-contract.md; wire names, error codes and closed denial
// reason sets stay byte-identical where they cross the wire.
package computer
