// The managed-wire delivery pump. Scheduling facts and leases stay in the
// delivery store (PrepareManagedDispatches commits every decision). Launch
// rows stay in the agent service. This pump decides when to scan, reserves a
// cold-start launch when a due managed input has none, retries unconfirmed
// starts, and performs the post-commit send half: it builds the agent:deliver
// body and sends it through SendWithAdmission.
//
// Lock order for that send: the hub acquires the machine slot, then the
// admission callback enters the authority fence, re-reads Agent/channel/launch
// facts, and only then enqueues. The callback never takes the slot (it is
// already held). No path here holds the fence and then waits for a slot.
// Start reservation and RecoverPendingStarts finish their own transactions
// before any gateway call, and this pump does not hold a transaction across
// either call.
//
// Wake sources: a commit listener and a periodic scan. A dropped wake is safe
// because the durable rows remain. Shutdown joins the worker before the
// database closes.
package agentdelivery

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/onboarding"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/delivery"
	platformdb "raft.local/server-go/internal/platform/db"
)

const (
	dispatchWakeBuffer     = 256
	dispatchTickerEvery    = delivery.WaitingRecheckBackoff
	startLaunchMaxScan     = 16
	startRecoverFetchLimit = 64
	prepareMaxTotal        = 64
)

// Dispatcher is the single managed-wire pump. Start launches the worker;
// Close cancels it and joins the goroutine.
type Dispatcher struct {
	svc     *Service
	sender  AdmittedSender
	encoder WireEncoder
	logger  *slog.Logger

	wake         chan struct{}
	wakesDrop    atomic.Uint64
	suppressWake atomic.Bool

	// mu serializes Start and Close setup only. It is never held while a
	// database transaction or the authority fence is acquired. Wake does not
	// take it: commit listeners run after the fence is released and must not
	// wait on shutdown. Holding mu across lease recovery would let a blocked
	// database call stop Close from cancelling the worker.
	mu         sync.Mutex
	cancel     context.CancelFunc
	done       chan struct{}
	stopListen func()
	started    bool
	closed     bool

	// startRecoverMu guards retry spacing and the bounded recovery cursor.
	// It is not mu and is never held across a database call or gateway
	// send: those take the authority fence or the machine slot.
	startRecoverMu        sync.Mutex
	startRecoverNotBefore map[string]time.Time
	startRecoverAfter     startRecoveryCandidate
}

// NewDispatcher validates the pump. The sender, encoder and service are
// required; there is no send path that skips admission.
func NewDispatcher(svc *Service, sender AdmittedSender, encoder WireEncoder, logger *slog.Logger) (*Dispatcher, error) {
	if svc == nil || sender == nil || encoder == nil {
		return nil, errors.New("agentdelivery: dispatcher requires the delivery service, admitted sender and wire encoder")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Dispatcher{
		svc: svc, sender: sender, encoder: encoder, logger: logger,
		wake: make(chan struct{}, dispatchWakeBuffer),
		done: make(chan struct{}),
	}, nil
}

// Wake offers one scan wake. A full buffer drops the offer because the
// durable backlog is the authority, not the wake.
func (d *Dispatcher) Wake() {
	// Commits made by this pump (briefing reconcile, an empty prepare) must
	// not schedule another pass. The durable rows remain, and the recovery
	// ticker still scans. An external commit that lands in this window is
	// the same dropped-wake case.
	if d.suppressWake.Load() {
		return
	}
	select {
	case d.wake <- struct{}{}:
	default:
		n := d.wakesDrop.Add(1)
		if n == 1 || n%1000 == 0 {
			d.logger.Warn("agentdelivery: wake queue full; scan wake dropped (backlog is durable)",
				"dropped_total", n)
		}
	}
}

// Start launches one worker and registers the commit listener. A second Start
// is a no-op, and Start after Close does not resurrect the pump. Expired-lease
// recovery and the first scan run on the worker so Close can cancel them
// without waiting on a lock held across the database fence.
func (d *Dispatcher) Start(parent context.Context) {
	d.mu.Lock()
	if d.closed || d.started {
		d.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	d.cancel = cancel
	// Enable suppression before exposing the listener. If the worker has
	// not been scheduled yet, a commit callback must not queue a redundant
	// scan behind the initial recovery scan. Startup scans the durable
	// facts regardless; the periodic scan covers dropped concurrent wakes.
	d.suppressWake.Store(true)
	d.stopListen = platformdb.RegisterCommitListener(d.svc.store.DB(), d.Wake)
	d.started = true
	d.mu.Unlock()
	go d.run(ctx)
}

func (d *Dispatcher) run(ctx context.Context) {
	defer close(d.done)
	// One startup recovery and one scan cycle. suppressWake covers both so
	// their commits cannot queue a second cycle. The ticker starts afterward;
	// its first fire is still one WaitingRecheckBackoff later, and a wake
	// that arrives once suppression drops is an external edge, not a replay
	// of this startup.
	d.suppressWake.Store(true)
	if _, err := d.svc.store.RecoverExpiredLeases(ctx, time.Now()); err != nil && ctx.Err() == nil {
		d.logger.Warn("agentdelivery: expired lease recovery failed", "error", err.Error())
	}
	if ctx.Err() == nil {
		d.scan(ctx)
	}
	d.suppressWake.Store(false)
	if ctx.Err() != nil {
		return
	}
	ticker := time.NewTicker(dispatchTickerEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-d.wake:
		case <-ticker.C:
		}
		for {
			select {
			case <-d.wake:
				continue
			default:
			}
			break
		}
		d.scan(ctx)
		if ctx.Err() != nil {
			return
		}
	}
}

// scan runs passes until the page is idle, the context ends, or a pass fails.
// Own commits stay suppressed so a successful write cannot wake this pump
// into another cycle; the durable rows and the ticker remain the recovery.
func (d *Dispatcher) scan(ctx context.Context) {
	d.suppressWake.Store(true)
	defer d.suppressWake.Store(false)
	for {
		more, err := d.pass(ctx)
		if err != nil {
			if ctx.Err() == nil {
				d.logger.Warn("agentdelivery: dispatch pass failed", "error", err.Error())
			}
			return
		}
		if !more {
			return
		}
		if ctx.Err() != nil {
			return
		}
	}
}

func (d *Dispatcher) pass(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if err := d.svc.briefings.Reconcile(ctx); err != nil && ctx.Err() == nil {
		d.logger.Warn("agentdelivery: briefing reconcile failed", "error", err.Error())
	}
	// Reserve and retry starts BEFORE PrepareManagedDispatches. That write
	// moves an incomplete identity to waiting_identity and sets
	// next_attempt_at = now+WaitingRecheckBackoff. Selecting candidates
	// afterwards never sees a due row: every later scan pushes the
	// timestamp forward first, so a managed input with no launch never
	// starts. Both calls below commit their own short transactions and
	// only then touch the gateway. This method does not hold a fence
	// across them, so the gateway's slot → fence order stays one way.
	recovered := d.recoverUnconfirmedStarts(ctx)
	started := d.ensureStartLaunches(ctx)
	// PrepareManagedDispatches no longer rewrites external claim rows. It
	// skips them and keeps an independent keyset cursor, so a mixed backlog
	// does not move next_attempt_at or hide pull-path mail. Skip the write
	// when nothing non-external is due so an idle or claim-only database
	// does not take a transaction only to observe that.
	managedDue, err := d.managedWireDue(ctx)
	if err != nil {
		return false, err
	}
	var plans []delivery.DispatchPlan
	if managedDue {
		plans, err = d.svc.store.PrepareManagedDispatches(ctx, d.svc.DispatchDeps(), delivery.PrepareInput{MaxTotal: prepareMaxTotal})
		if err != nil {
			return false, err
		}
	}
	for i := range plans {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		d.dispatchPlan(ctx, plans[i])
	}
	if err := d.svc.briefings.FinalizeReported(ctx); err != nil && ctx.Err() == nil {
		d.logger.Warn("agentdelivery: briefing finalize failed", "error", err.Error())
	}
	// Another pass only when this one made progress. A start reservation
	// hides that agent from the next candidate page; a recovery call stamps
	// the machine so the next pass does not send again. An idle database
	// stays false, so reconcile cannot wake itself.
	return len(plans) > 0 || started || recovered, nil
}

// managedWireDue reports whether any non-external delivery is due for the
// managed scanner. External claim-path rows are omitted so the precheck
// matches what PrepareManagedDispatches will lease. Omitting them is not
// what keeps pull eligibility stable: the scanner itself leaves those rows
// unchanged.
func (d *Dispatcher) managedWireDue(ctx context.Context) (bool, error) {
	now := time.Now().UnixMilli()
	var one int
	err := d.svc.store.DB().QueryRowContext(ctx, `
		SELECT 1
		FROM agent_deliveries d
		JOIN agents a ON a.id = d.agent_id AND a.workspace_id = d.workspace_id
		WHERE a.deleted_at IS NULL
		  AND lower(a.runtime) <> 'external'
		  AND (
		    (d.scheduling_state IN ('pending', 'waiting_machine', 'waiting_identity') AND d.next_attempt_at <= ?)
		    OR (d.scheduling_state = 'leased' AND d.lease_expires_at <= ?)
		  )
		LIMIT 1`, now, now).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (d *Dispatcher) dispatchPlan(ctx context.Context, plan delivery.DispatchPlan) {
	outcome := delivery.SendOutcome{
		OccurrenceID: plan.Attempt.OccurrenceID,
		Accepted:     false,
		ErrorCode:    "send_failed",
		Recoverable:  true,
	}
	machineID := ""
	if plan.Attempt.MachineSnapshot.Valid {
		machineID = plan.Attempt.MachineSnapshot.String
	}
	payload, err := d.frame(ctx, plan)
	if err != nil {
		var denied *AdmissionDenied
		if errors.As(err, &denied) {
			outcome.ErrorCode = denied.Reason
			outcome.Recoverable = denied.Recoverable
		} else {
			outcome.ErrorCode = "invalid_delivery_frame"
			outcome.Recoverable = false
		}
		d.logger.Warn("agentdelivery: delivery frame refused",
			"delivery_id", plan.Delivery.ID, "error", err.Error())
		d.record(ctx, outcome)
		return
	}
	err = holdAdmission(ctx, d.sender, d.svc.store.DB(), machineID, payload, func(ctx context.Context, principal computer.Principal) error {
		return d.svc.admit(ctx, principal, plan)
	})
	if err != nil {
		outcome.ErrorCode, outcome.Recoverable = classifyDispatchFailure(err)
		d.logger.Info("agentdelivery: managed dispatch not admitted",
			"delivery_id", plan.Delivery.ID, "machine_id", machineID,
			"code", outcome.ErrorCode, "error", err.Error())
		d.record(ctx, outcome)
		return
	}
	outcome.Accepted = true
	outcome.ErrorCode = ""
	d.record(ctx, outcome)
}

func (d *Dispatcher) frame(ctx context.Context, plan delivery.DispatchPlan) (any, error) {
	if plan.Delivery.SourceKind == delivery.SourceBriefing {
		notice, err := d.svc.briefings.BriefingTx(ctx, d.svc.store.DB(), plan.Delivery)
		if err != nil {
			if errors.Is(err, onboarding.ErrBriefingUnavailable) {
				return nil, &AdmissionDenied{Reason: "briefing_unauthorized", Recoverable: false}
			}
			return nil, err
		}
		body, err := d.encoder.EncodeControl(ControlNotice{
			WorkspaceID: notice.WorkspaceID, AgentID: notice.AgentID,
			NoticeID: notice.NoticeID, ChannelID: notice.ChannelID,
			ChannelName: notice.ChannelName, Content: notice.Content,
			CreatedAt: notice.CreatedAt,
		})
		if err != nil {
			return nil, err
		}
		if len(body) == 0 || !json.Valid(body) {
			return nil, &AdmissionDenied{Reason: "invalid_delivery_frame", Recoverable: false}
		}
		return agent.NewControlDeliveryCommand(plan.Delivery.AgentID, body, plan.Attempt.OccurrenceID)
	}
	messageID := ""
	if plan.Attempt.MessageID.Valid {
		messageID = plan.Attempt.MessageID.String
	}
	if !plan.Delivery.ConversationID.Valid || messageID == "" {
		return nil, &AdmissionDenied{Reason: "conversation_removed", Recoverable: false}
	}
	facts, err := d.svc.conversations.MessageFacts(ctx, plan.Delivery.WorkspaceID,
		plan.Delivery.ConversationID.String, messageID, plan.Delivery.AgentID)
	if err != nil {
		return nil, &AdmissionDenied{Reason: "facts_unavailable", Recoverable: true}
	}
	body, err := d.encoder.EncodeMessage(facts)
	if err != nil {
		return nil, err
	}
	snapshot := agent.MentionDeliverySnapshot{
		OccurrenceID: plan.Attempt.OccurrenceID,
		MessageID:    messageID,
		MachineID:    plan.Attempt.MachineSnapshot.String,
		LaunchID:     plan.Attempt.LaunchSnapshot.String,
		SessionID:    plan.Attempt.SessionSnapshot.String,
	}
	command, err := agent.NewMentionDeliveryCommand(plan.Delivery.AgentID, body, plan.MessageSeq, snapshot)
	if err != nil {
		return nil, &AdmissionDenied{Reason: "invalid_delivery_frame", Recoverable: false}
	}
	return command, nil
}

func (d *Dispatcher) record(ctx context.Context, outcome delivery.SendOutcome) {
	if err := d.svc.store.RecordManagedSendResult(ctx, outcome); err != nil && ctx.Err() == nil {
		d.logger.Warn("agentdelivery: send result record failed",
			"occurrence_id", outcome.OccurrenceID, "error", err.Error())
	}
}

func classifyDispatchFailure(err error) (string, bool) {
	var denied *AdmissionDenied
	if errors.As(err, &denied) {
		if denied.Reason == "" {
			return "admission_denied", denied.Recoverable
		}
		return denied.Reason, denied.Recoverable
	}
	switch {
	case errors.Is(err, ErrMachineOffline):
		return "machine_offline", true
	case errors.Is(err, ErrHubClosed):
		return "hub_closed", true
	case errors.Is(err, ErrSendDeferred):
		return "send_queue_full", true
	case errors.Is(err, ErrDispatchRefused):
		return "dispatch_refused", false
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "dispatch_canceled", true
	}
	if domain := agent.AsError(err); domain != nil && domain.Status >= 400 && domain.Status < 500 {
		return "dispatch_refused", false
	}
	return "send_failed", true
}

// holdAdmission sends payload through the admitted sender. The allow callback
// runs inside the machine slot and inside the authority fence, and enqueue
// runs only after allow returns nil, still inside that fence.
func holdAdmission(ctx context.Context, sender AdmittedSender, handle *sql.DB, machineID string, payload any, allow func(context.Context, computer.Principal) error) error {
	return sender.SendAdmitted(ctx, machineID, payload, func(ctx context.Context, principal computer.Principal, enqueue func() error) error {
		return platformdb.WithAuthorityReadContext(ctx, handle, func() error {
			if err := allow(ctx, principal); err != nil {
				return err
			}
			return enqueue()
		})
	})
}

func (d *Dispatcher) ensureStartLaunches(ctx context.Context) bool {
	if err := ctx.Err(); err != nil {
		return false
	}
	candidates, err := d.startLaunchCandidates(ctx)
	if err != nil {
		if ctx.Err() == nil {
			d.logger.Warn("agentdelivery: identity-wait scan failed", "error", err.Error())
		}
		return false
	}
	started := false
	for _, c := range candidates {
		if ctx.Err() != nil {
			return started
		}
		row, err := d.svc.directory.GetAgent(ctx, c.agentID, false)
		if err != nil || row == nil || row.WorkspaceID != c.workspaceID {
			if err != nil && ctx.Err() == nil {
				d.logger.Warn("agentdelivery: identity-wait agent load failed",
					"agent_id", c.agentID, "error", err.Error())
			}
			continue
		}
		if row.Status == agent.StatusStopped || agent.IsExternalAgentRuntime(row.Runtime) || !row.MachineID.Valid || row.MachineID.String == "" {
			continue
		}
		if _, err := d.svc.agents.EnsureStartLaunch(ctx, row); err != nil {
			if ctx.Err() == nil {
				d.logger.Info("agentdelivery: start launch not ensured",
					"agent_id", c.agentID, "workspace_id", c.workspaceID, "reason", err.Error())
			}
			continue
		}
		// The reservation is the durable wake. EnsureStartLaunch already
		// attempted the send when the machine was online, and it does not
		// resend a dispatched launch. Stamp the machine so the next pass
		// waits out StartResendBackoff instead of queueing that reserved
		// row again. RecoverPendingStarts has no backoff of its own for a
		// reserved launch: last_dispatch_at is written only after a send
		// is accepted.
		started = true
		d.noteStartAttempt(row.MachineID.String, time.Now())
	}
	return started
}

type identityWaitCandidate struct {
	workspaceID string
	agentID     string
}

func (d *Dispatcher) startLaunchCandidates(ctx context.Context) ([]identityWaitCandidate, error) {
	// pending is included because the first due scan has not classified the
	// row yet. waiting_machine is the offline/not-yet-reachable projection;
	// EnsureStartLaunch still reserves (the durable wake) and only sends
	// when the gateway is online. An acked launch counts as the current
	// generation: a missing confirmed_session_id is not a reason to mint
	// another launch. The row is not filtered by launch machine — a stale
	// open launch is the agent owner's to supersede.
	rows, err := d.svc.store.DB().QueryContext(ctx, `
		SELECT d.workspace_id, d.agent_id
		FROM agent_deliveries d
		JOIN agents a ON a.id = d.agent_id AND a.workspace_id = d.workspace_id
		WHERE d.scheduling_state IN ('pending', 'waiting_machine', 'waiting_identity')
		  AND d.next_attempt_at <= ?
		  AND a.deleted_at IS NULL
		  AND a.status != 'stopped'
		  AND lower(a.runtime) <> 'external'
		  AND a.machine_id IS NOT NULL
		  AND NOT EXISTS (
			SELECT 1 FROM agent_launches l
			WHERE l.workspace_id = d.workspace_id AND l.agent_id = d.agent_id
			  AND l.state IN ('reserved','dispatched','acked'))
		GROUP BY d.workspace_id, d.agent_id
		ORDER BY MIN(d.next_attempt_at), d.agent_id
		LIMIT ?`, time.Now().UnixMilli(), startLaunchMaxScan)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []identityWaitCandidate
	for rows.Next() {
		var c identityWaitCandidate
		if err := rows.Scan(&c.workspaceID, &c.agentID); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// recoverUnconfirmedStarts retries launches that still owe agent:start.
// OnReady covers reconnect. This scan covers the socket that stayed up:
// a queue error leaves the launch reserved, and a lost start ack leaves it
// dispatched. Spacing is agent.StartResendBackoffMS per machine, counted
// from this pump's last attempt. The service method itself also skips a
// dispatched launch inside that window. Stopped, deleted, and reassigned
// agents are not sent a start; RecoverPendingStarts closes those launches.
//
// The readmodel query is closed before any service call. RecoverPendingStarts
// reads, then sends. Nothing here holds the authority fence while that send
// takes the machine slot.
func (d *Dispatcher) recoverUnconfirmedStarts(ctx context.Context) bool {
	if err := ctx.Err(); err != nil {
		return false
	}
	now := time.Now()
	d.startRecoverMu.Lock()
	after := d.startRecoverAfter
	d.startRecoverMu.Unlock()
	machines, err := d.unconfirmedStartMachines(ctx, now, after)
	if err != nil {
		if ctx.Err() == nil {
			d.logger.Warn("agentdelivery: unconfirmed start scan failed", "error", err.Error())
		}
		return false
	}
	called := false
	calls := 0
	for _, machine := range machines {
		if ctx.Err() != nil {
			return called
		}
		if !d.startRecoveryDue(machine.machineID, now) {
			d.advanceStartRecovery(machine)
			continue
		}
		if calls >= startLaunchMaxScan {
			// Keep the cursor at the last examined machine, not the end of
			// the fetched page. The next pass must visit this candidate.
			return true
		}
		calls++
		called = true
		if err := d.svc.agents.RecoverPendingStarts(ctx, machine.machineID); err != nil && ctx.Err() == nil {
			d.logger.Warn("agentdelivery: pending start recovery failed",
				"machine_id", machine.machineID, "error", err.Error())
		}
		d.noteStartAttempt(machine.machineID, time.Now())
		d.advanceStartRecovery(machine)
	}
	if len(machines) == startRecoverFetchLimit {
		// Even a page containing only cooling-down or offline machines
		// must advance. Failed reserved launches do not change their
		// durable ordering key and otherwise hide every later page.
		return true
	}
	d.startRecoverMu.Lock()
	d.startRecoverAfter = startRecoveryCandidate{}
	// Completed sweeps also retire expired spacing entries for machines
	// that no longer have pending launches (including deleted machines).
	for machineID, until := range d.startRecoverNotBefore {
		if !now.Before(until) {
			delete(d.startRecoverNotBefore, machineID)
		}
	}
	d.startRecoverMu.Unlock()
	return called
}

type startRecoveryCandidate struct {
	machineID     string
	oldestAttempt int64
}

func (d *Dispatcher) advanceStartRecovery(machine startRecoveryCandidate) {
	d.startRecoverMu.Lock()
	d.startRecoverAfter = machine
	d.startRecoverMu.Unlock()
}

func (d *Dispatcher) unconfirmedStartMachines(ctx context.Context, now time.Time, after startRecoveryCandidate) ([]startRecoveryCandidate, error) {
	dueBefore := now.Add(-time.Duration(agent.StartResendBackoffMS) * time.Millisecond).UnixMilli()
	rows, err := d.svc.store.DB().QueryContext(ctx, `
		SELECT l.machine_id, MIN(COALESCE(l.last_dispatch_at, l.created_at)) AS oldest_attempt
		FROM agent_launches l
		JOIN agents a ON a.id = l.agent_id AND a.workspace_id = l.workspace_id
		WHERE l.state IN ('reserved', 'dispatched')
		  AND lower(a.runtime) <> 'external'
		  AND (
		    l.state = 'reserved'
		    OR l.last_dispatch_at IS NULL
		    OR l.last_dispatch_at <= ?
		  )
		GROUP BY l.machine_id
		HAVING (? = '' OR oldest_attempt > ? OR (oldest_attempt = ? AND l.machine_id > ?))
		ORDER BY oldest_attempt, l.machine_id
		LIMIT ?`, dueBefore, after.machineID, after.oldestAttempt, after.oldestAttempt, after.machineID, startRecoverFetchLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []startRecoveryCandidate
	for rows.Next() {
		var machine startRecoveryCandidate
		if err := rows.Scan(&machine.machineID, &machine.oldestAttempt); err != nil {
			return nil, err
		}
		if machine.machineID == "" {
			continue
		}
		out = append(out, machine)
	}
	return out, rows.Err()
}

func (d *Dispatcher) startRecoveryDue(machineID string, now time.Time) bool {
	d.startRecoverMu.Lock()
	defer d.startRecoverMu.Unlock()
	until, ok := d.startRecoverNotBefore[machineID]
	return !ok || !now.Before(until)
}

func (d *Dispatcher) noteStartAttempt(machineID string, now time.Time) {
	if machineID == "" {
		return
	}
	d.startRecoverMu.Lock()
	defer d.startRecoverMu.Unlock()
	if d.startRecoverNotBefore == nil {
		d.startRecoverNotBefore = map[string]time.Time{}
	}
	until := now.Add(time.Duration(agent.StartResendBackoffMS) * time.Millisecond)
	if prev, ok := d.startRecoverNotBefore[machineID]; !ok || until.After(prev) {
		d.startRecoverNotBefore[machineID] = until
	}
}

// Close stops the pump and joins the worker. A dispatcher that was never
// started returns immediately. A second Close waits for the same join.
// Close after a successful Start always observes that Start: setup is
// serialized with Start, and the join happens after the lock is released so
// cancellation is not stuck behind in-flight database work.
func (d *Dispatcher) Close() error {
	d.mu.Lock()
	if d.closed {
		started := d.started
		d.mu.Unlock()
		if started {
			<-d.done
		}
		return nil
	}
	d.closed = true
	cancel := d.cancel
	stop := d.stopListen
	d.cancel = nil
	d.stopListen = nil
	started := d.started
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if stop != nil {
		stop()
	}
	if started {
		<-d.done
	}
	return nil
}
