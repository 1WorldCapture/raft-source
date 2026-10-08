GO ?= go
NODE ?= node

.PHONY: check fmt-check vet test race test-http build cross-build vuln

# Backend only: no browser, frontend build, TS server, Postgres or Redis.
check: fmt-check vet test race test-http

fmt-check:
	@files="$$(gofmt -l .)"; if [ -n "$$files" ]; then printf 'Unformatted Go files:\n%s\n' "$$files"; exit 1; fi

vet:
	$(GO) vet ./...

test:
	$(GO) test -count=1 ./...

race:
	$(GO) test -race -count=1 ./...

test-http:
	$(NODE) tests/acceptance/run.mjs

build:
	CGO_ENABLED=0 $(GO) build -o bin/raft-server ./cmd/raft-server

# Compilation evidence only; not a claim of runtime testing on these systems.
cross-build:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build ./...
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 $(GO) build ./...

# Requires network access; scanner is not a server/module runtime dependency.
vuln:
	$(GO) run golang.org/x/vuln/cmd/govulncheck@v1.8.0 -show verbose ./...
