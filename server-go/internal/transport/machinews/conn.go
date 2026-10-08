package machinews

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"raft.local/server-go/internal/computer"
)

// machineConn is one daemon/Computer connection. Delayed effects run only
// while it is still the machine slot's published connection.
type machineConn struct {
	hub        *Hub
	slot       *machineSlot
	ws         *websocket.Conn
	machineID  string
	serverID   string
	principal  computer.Principal
	kind       string
	generation uint64

	ctx    context.Context
	cancel context.CancelFunc

	stateMu         sync.Mutex
	lastPong        time.Time
	lastIngress     time.Time
	daemonVersion   string
	computerVersion string
	capabilities    []string
	runtimes        []string
	runtimeVersions map[string]string
	hostKind        string
	shutdownIntent  *shutdownIntent
	pendingReady    *pendingReady
	factsRetryStop  func()

	sendQueue  chan []byte
	limiter    *ingressLimiter
	localCause atomic.Value // string
	stopTick   func()
	finished   atomic.Bool
	ended      atomic.Bool

	admitMu sync.Mutex
	retired bool
}

type shutdownIntent struct {
	Reason     string    `json:"reason"`
	ReceivedAt time.Time `json:"receivedAt"`
}

type pendingReady struct {
	facts           readyFacts
	raw             json.RawMessage
	daemonVersion   string
	computerVersion string
	capabilities    []string
	runtimes        []string
	runtimeVersions map[string]string
	hostKind        string
}

func (c *machineConn) markRetired() {
	c.admitMu.Lock()
	c.retired = true
	c.admitMu.Unlock()
}

func (c *machineConn) isRetired() bool {
	c.admitMu.Lock()
	defer c.admitMu.Unlock()
	return c.retired
}

// callbackContext is canceled when this generation is retired or the hub
// closes. It carries the generation scope Hub.Send consults.
func (c *machineConn) callbackContext() context.Context {
	return withFrameScope(c.ctx, c)
}

// armHeartbeat starts the ping loop. publish calls it while holding the
// machine lock so retire cannot miss the stop function.
func (c *machineConn) armHeartbeat() {
	if c.stopTick != nil || c.hub == nil {
		return
	}
	c.stopTick = c.hub.bindTick(c.hub.cfg.HeartbeatInterval, c.heartbeatTick)
}

func (c *machineConn) setLocalCause(cause string) {
	if c.localCause.Load() == nil {
		c.localCause.Store(cause)
	}
}

func (c *machineConn) localCauseOr(fallback string) string {
	if v, ok := c.localCause.Load().(string); ok && v != "" {
		return v
	}
	return fallback
}

func (c *machineConn) markIngress(now time.Time) {
	c.stateMu.Lock()
	c.lastIngress = now
	c.stateMu.Unlock()
}

func (c *machineConn) heartbeatProof() time.Time {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.lastPong.After(c.lastIngress) {
		return c.lastPong
	}
	return c.lastIngress
}

func (c *machineConn) ShutdownIntent() *shutdownIntent {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.shutdownIntent == nil {
		return nil
	}
	copyIntent := *c.shutdownIntent
	return &copyIntent
}

func (c *machineConn) cloneLive() *LiveConnection {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	snap := &LiveConnection{
		MachineID:       c.machineID,
		ServerID:        c.serverID,
		Generation:      c.generation,
		DaemonVersion:   c.daemonVersion,
		ComputerVersion: c.computerVersion,
		HostKind:        c.hostKind,
		RuntimeVersions: make(map[string]string, len(c.runtimeVersions)),
	}
	snap.Capabilities = append([]string(nil), c.capabilities...)
	snap.Runtimes = append([]string(nil), c.runtimes...)
	for k, v := range c.runtimeVersions {
		snap.RuntimeVersions[k] = v
	}
	if c.shutdownIntent != nil {
		intent := *c.shutdownIntent
		snap.ShutdownIntent = &intent
	}
	return snap
}

func (c *machineConn) serve() {
	defer c.hub.life.leave()
	for {
		_, data, err := c.ws.Read(c.ctx)
		if err != nil {
			cause := c.localCauseOr(causeSocketError)
			if websocket.CloseStatus(err) != -1 {
				cause = c.localCauseOr(causeSocketClose)
			}
			c.hub.endConnection(c, cause)
			return
		}
		now := c.hub.clock.Now()
		c.markIngress(now)
		c.handleFrame(data, now)
	}
}

func (c *machineConn) handleFrame(data []byte, now time.Time) {
	frameType, err := parseEnvelope(data)
	if err != nil {
		c.hub.logger.Warn("machine connection sent an invalid frame",
			"machine_id", c.machineID, "error", err.Error())
		return
	}
	if ok, dropped := c.limiter.allow(now, frameType); !ok {
		if dropped == 1 || dropped%invalidReasonLogSuppression == 0 {
			c.hub.logger.Warn("daemon ingress rate limited; dropping frame",
				"machine_id", c.machineID, "frame_type", frameType, "dropped", dropped)
		}
		return
	}
	switch frameType {
	case frameTypePing:
		c.trySendLocal(pingBytes)
		return
	case frameTypePong:
		c.stateMu.Lock()
		c.lastPong = now
		c.stateMu.Unlock()
		err := c.hub.withCurrent(c, "pong", func(ctx context.Context) error {
			writeCtx, cancel := context.WithTimeout(ctx, factsWriteTimeout)
			defer cancel()
			return c.hub.facts.touchHeartbeat(writeCtx, c.machineID, now, c.principal)
		})
		if err != nil && !errors.Is(err, errStale) && !errors.Is(err, context.Canceled) && computer.AsAuthError(err) == nil {
			c.hub.logger.Error("failed to persist machine heartbeat",
				"machine_id", c.machineID, "error", err.Error())
		}
		c.noteAuth(err)
		return
	case frameTypeReady:
		var frame readyFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			c.hub.logger.Warn("machine sent a malformed ready frame",
				"machine_id", c.machineID, "error", err.Error())
			return
		}
		if err := validateReady(&frame); err != nil {
			c.hub.logger.Warn("machine sent an invalid ready frame",
				"machine_id", c.machineID, "error", err.Error())
			return
		}
		c.persistReady(readyFromFrame(c, frame, data, now))
		return
	case frameTypeShutdown:
		var frame struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(data, &frame)
		reason := "unknown"
		if shutdownReasons[frame.Reason] {
			reason = frame.Reason
		}
		err := c.hub.withCurrent(c, "shutdown", func(context.Context) error {
			c.stateMu.Lock()
			c.shutdownIntent = &shutdownIntent{Reason: reason, ReceivedAt: now}
			c.stateMu.Unlock()
			return nil
		})
		if err == nil {
			c.hub.logger.Info("machine reported shutdown intent",
				"machine_id", c.machineID, "reason", reason)
		}
		c.noteAuth(err)
		return
	default:
		err := c.hub.withCurrent(c, "message", func(ctx context.Context) error {
			if c.hub.cfg.OnMessage == nil {
				return nil
			}
			return c.hub.cfg.OnMessage(ctx, c.principal, json.RawMessage(data))
		})
		if err != nil && !errors.Is(err, errStale) && !errors.Is(err, context.Canceled) && computer.AsAuthError(err) == nil {
			c.hub.logger.Warn("machine message handler rejected a frame",
				"machine_id", c.machineID, "frame_type", frameType, "error", err.Error())
		}
		c.noteAuth(err)
		return
	}
}

func readyFromFrame(c *machineConn, frame readyFrame, raw []byte, now time.Time) *pendingReady {
	return &pendingReady{
		facts: readyFacts{
			MachineID:       c.machineID,
			Runtimes:        frame.Runtimes,
			Hostname:        frame.Hostname,
			OS:              frame.OS,
			DaemonVersion:   frame.DaemonVersion,
			ComputerVersion: stringValue(frame.ComputerVersion),
			ObservedAt:      now,
		},
		raw:             append([]byte(nil), raw...),
		daemonVersion:   stringValue(frame.DaemonVersion),
		computerVersion: stringValue(frame.ComputerVersion),
		capabilities:    normalizeCapabilities(frame.Capabilities),
		runtimes:        append([]string(nil), frame.Runtimes...),
		runtimeVersions: normalizeRuntimeVersions(frame.RuntimeVersions, frame.Runtimes),
		hostKind:        normalizeComputerHostKind(frame.HostKind),
	}
}

// persistReady writes incoming when non-nil, otherwise the pending payload.
// OnReady runs only after that payload commits, and a newer pending payload
// replaces one that has not committed.
func (c *machineConn) persistReady(incoming *pendingReady) {
	var persisted bool
	err := c.hub.admitCurrent(c, "ready", func(ctx context.Context) error {
		if incoming != nil {
			c.rememberReady(incoming)
		}
		if err := c.hub.revalidate(ctx, c.principal); err != nil {
			return err
		}
		if !c.hub.owns(c.slot, c) {
			return errStale
		}
		c.stateMu.Lock()
		pending := c.pendingReady
		c.stateMu.Unlock()
		if pending == nil {
			return nil
		}
		writeCtx, cancel := context.WithTimeout(ctx, factsWriteTimeout)
		err := c.hub.facts.applyReady(writeCtx, pending.facts, c.principal)
		cancel()
		if err != nil {
			return err
		}
		persisted = true
		c.stateMu.Lock()
		if c.pendingReady == pending {
			c.pendingReady = nil
		}
		fire := c.pendingReady == nil
		raw := append(json.RawMessage(nil), pending.raw...)
		c.stateMu.Unlock()
		if !fire || c.hub.cfg.OnReady == nil {
			return nil
		}
		if cbErr := c.hub.cfg.OnReady(ctx, c.principal, raw); cbErr != nil {
			c.hub.logger.Warn("OnReady callback failed",
				"machine_id", c.machineID, "error", cbErr.Error())
		}
		c.hub.logger.Info("machine ready", "machine_id", c.machineID, "daemon_version", pending.daemonVersion)
		return nil
	})
	if persisted || err == nil {
		c.stopFactsRetry()
		c.noteAuth(err)
		return
	}
	if !retryableReady(err) || c.ctx.Err() != nil || c.hub.closing.Load() {
		c.stopFactsRetry()
		c.noteAuth(err)
		return
	}
	c.hub.logger.Warn("failed to persist machine ready facts; will retry",
		"machine_id", c.machineID, "error", err.Error())
	c.scheduleReadyRetry()
}

func (c *machineConn) rememberReady(pending *pendingReady) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	c.daemonVersion = pending.daemonVersion
	c.computerVersion = pending.computerVersion
	c.capabilities = append([]string(nil), pending.capabilities...)
	c.runtimes = append([]string(nil), pending.runtimes...)
	c.runtimeVersions = make(map[string]string, len(pending.runtimeVersions))
	for k, v := range pending.runtimeVersions {
		c.runtimeVersions[k] = v
	}
	c.hostKind = pending.hostKind
	c.pendingReady = pending
}

func retryableReady(err error) bool {
	if err == nil || errors.Is(err, errStale) || errors.Is(err, context.Canceled) {
		return false
	}
	return computer.AsAuthError(err) == nil
}

func (c *machineConn) scheduleReadyRetry() {
	if c.isRetired() || c.hub.closing.Load() {
		return
	}
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.factsRetryStop != nil || c.pendingReady == nil {
		return
	}
	c.factsRetryStop = c.hub.bindAfter(c.hub.cfg.ReadyRetryInterval, func() {
		c.stateMu.Lock()
		c.factsRetryStop = nil
		c.stateMu.Unlock()
		c.persistReady(nil)
	})
}

func (c *machineConn) stopFactsRetry() {
	c.stateMu.Lock()
	stop := c.factsRetryStop
	c.factsRetryStop = nil
	c.stateMu.Unlock()
	if stop != nil {
		stop()
	}
}

func (c *machineConn) noteAuth(err error) {
	if computer.AsAuthError(err) != nil {
		c.stopFactsRetry()
		c.hub.revoke(c, err)
	}
}

func (c *machineConn) heartbeatTick() {
	if c.hub.closing.Load() || c.isRetired() {
		return
	}
	now := c.hub.clock.Now()
	proof := c.heartbeatProof()
	if now.Sub(proof) > c.hub.cfg.HeartbeatTimeout {
		c.hub.logger.Warn("machine heartbeat timed out; terminating socket",
			"machine_id", c.machineID, "proof_age_ms", now.Sub(proof).Milliseconds())
		c.setLocalCause(causeHeartbeatTimeout)
		_ = c.ws.CloseNow()
		return
	}
	err := c.hub.withCurrent(c, "heartbeat", nil)
	if errors.Is(err, errStale) || errors.Is(err, context.Canceled) {
		return
	}
	if err != nil {
		c.noteAuth(err)
		if computer.AsAuthError(err) == nil {
			c.hub.logger.Warn("machine principal revalidation failed",
				"machine_id", c.machineID, "error", err.Error())
		}
		return
	}
	c.trySendLocal(pingBytes)
}

func (c *machineConn) trySendLocal(frame []byte) {
	c.admitMu.Lock()
	retired := c.retired
	c.admitMu.Unlock()
	if retired {
		return
	}
	select {
	case c.sendQueue <- frame:
	default:
		c.hub.logger.Warn("machine send queue full; dropping transport frame",
			"machine_id", c.machineID)
	}
}

func (c *machineConn) writeLoop() {
	defer c.hub.life.leave()
	for {
		select {
		case <-c.ctx.Done():
			return
		case frame := <-c.sendQueue:
			if c.isRetired() || c.hub.closing.Load() {
				return
			}
			if err := c.hub.revalidate(c.ctx, c.principal); err != nil {
				if c.ctx.Err() != nil || errors.Is(err, context.Canceled) {
					return
				}
				if computer.AsAuthError(err) != nil {
					c.hub.revoke(c, err)
					return
				}
				c.hub.logger.Warn("outbound frame dropped; principal revalidation failed",
					"machine_id", c.machineID, "error", err.Error())
				continue
			}
			if c.isRetired() || c.ctx.Err() != nil {
				return
			}
			ctx, cancel := context.WithTimeout(c.ctx, c.hub.cfg.WriteTimeout)
			err := c.ws.Write(ctx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				c.setLocalCause(causeSocketError)
				_ = c.ws.CloseNow()
				return
			}
		}
	}
}

func (c *machineConn) writeContext() error {
	frame := machineContextFrame{
		Type:      frameTypeMachineContext,
		MachineID: c.machineID,
		ServerID:  c.serverID,
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.hub.cfg.WriteTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, data)
}

func (c *machineConn) retire() {
	if c.finished.CompareAndSwap(false, true) {
		if c.stopTick != nil {
			c.stopTick()
		}
		c.stopFactsRetry()
		if c.cancel != nil {
			c.cancel()
		}
	}
}

func (c *machineConn) enqueue(data []byte) error {
	c.admitMu.Lock()
	defer c.admitMu.Unlock()
	if c.retired {
		return ErrMachineOffline
	}
	select {
	case c.sendQueue <- data:
		return nil
	default:
		return ErrSendQueueFull
	}
}

func stringValue(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
