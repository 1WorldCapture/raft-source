GO ?= go
NODE ?= node
BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

.PHONY: check fmt-check vet test race test-reference test-m4-reference \
        test-m4-wire test-http test-m4-backend test-m4-realtime \
        test-m4-upgrade build cross-build vuln

# Backend only: no browser, frontend build, TS server, Postgres or Redis.
# `make check` is the honest backend gate: formatting, vet, unit + race tests,
# the frozen original-protocol reference suites (M2 workspaces + M4 messaging)
# including freshly collected Go wire against the original reducers/schema,
# and the full HTTP acceptance run — M1 through M4, including both frozen
# upgrade matrices — plus a release build. It proves backend behavior only;
# UI/product sign-off is tracked separately and no target here claims it. The
# reported build stage stays whatever internal/platform/buildinfo encodes.
check: fmt-check vet test race test-reference test-m4-reference test-m4-wire test-http build

fmt-check:
	@files="$$(gofmt -l .)"; if [ -n "$$files" ]; then printf 'Unformatted Go files:\n%s\n' "$$files"; exit 1; fi

vet:
	$(GO) vet ./...

test:
	$(GO) test -count=1 ./...

race:
	$(GO) test -race -count=1 ./...

test-reference:
	$(NODE) tests/acceptance/workspaces-reference.mjs

# M4 frozen original-protocol contracts: executes the pinned original TS
# sources and asserts the fixtures under contracts/m4 are byte-identical
# transcripts (idempotent --check mode; drop --check to regenerate after a
# reviewed baseline change). Invoked from the repo root because the reference
# runner resolves its self-test fixture relative to it.
test-m4-reference:
	cd .. && $(NODE) server-go/tests/acceptance/m4-reference/run.mjs --check

# Real Go public-API wire, collected by an in-process `go test` (no TCP, no
# listener, disposable store) and verified against the original TS reducers
# and the generated Activity JSON Schema. The gate is read-only: it verifies
# fresh runtime wire without rewriting contracts/m4/go-wire-samples.json.
# To explicitly refresh that evidence, run the same command without --check.
test-m4-wire:
	cd .. && $(NODE) server-go/tests/acceptance/m4-reference/run.mjs --go-wire --check

# Real-listener HTTP acceptance (tests/acceptance/run.mjs). SUITE selects the
# subset; default all runs every M1-M4 suite against one disposable database
# and dynamic loopback ports. The M4 suites fail loudly when a surface is not
# wired yet, so use SUITE to isolate while integration is in flight.
#   make test-http SUITE=persistence   | m4-backend | m4-realtime | m4-upgrade | ...
SUITE ?= $(if $(RAFT_GO_TEST_SUITE),$(RAFT_GO_TEST_SUITE),all)
test-http:
	RAFT_GO_TEST_SUITE=$(SUITE) $(NODE) tests/acceptance/run.mjs

test-m4-backend:
	RAFT_GO_TEST_SUITE=m4-backend $(NODE) tests/acceptance/run.mjs

test-m4-realtime:
	RAFT_GO_TEST_SUITE=m4-realtime $(NODE) tests/acceptance/run.mjs

# Both frozen M3 starting points (d275cce unpatched, bc65213 patched) built
# from committed source; the current executable upgrades that real data in
# place; the old binary must refuse the M4 schema; cold backup restores it.
test-m4-upgrade:
	RAFT_GO_TEST_SUITE=m4-upgrade $(NODE) tests/acceptance/run.mjs

build:
	CGO_ENABLED=0 $(GO) build -ldflags "-X raft.local/server-go/internal/platform/buildinfo.BuildTime=$(BUILD_TIME)" -o bin/raft-server ./cmd/raft-server

# Compilation evidence only; not a claim of runtime testing on these systems.
cross-build:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build ./...
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 $(GO) build ./...

# Requires network access; scanner is not a server/module runtime dependency.
vuln:
	$(GO) run golang.org/x/vuln/cmd/govulncheck@v1.8.0 -show verbose ./...
