package machinews

import "context"

// frameScope binds a callback context to one connection generation.
// Hub.Send refuses the send when this generation is no longer the
// machine's published connection, so a delayed callback cannot command
// the replacement socket.
type frameScope struct {
	machineID  string
	generation uint64
	conn       *machineConn
}

type frameScopeKey struct{}

func withFrameScope(ctx context.Context, c *machineConn) context.Context {
	if ctx == nil || c == nil {
		return ctx
	}
	return context.WithValue(ctx, frameScopeKey{}, frameScope{
		machineID:  c.machineID,
		generation: c.generation,
		conn:       c,
	})
}

func frameScopeFrom(ctx context.Context) (frameScope, bool) {
	if ctx == nil {
		return frameScope{}, false
	}
	scope, ok := ctx.Value(frameScopeKey{}).(frameScope)
	if !ok || scope.conn == nil || scope.machineID == "" {
		return frameScope{}, false
	}
	return scope, true
}
