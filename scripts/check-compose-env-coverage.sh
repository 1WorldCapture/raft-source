#!/bin/sh
# Guard (task #9/D5): every RAFT_MANAGED_MCP_* variable documented in
# deploy/docker/.env.example must be passed through the server service's
# environment in deploy/docker/docker-compose.yml — compose only does
# variable interpolation, an undocumented passthrough silently never reaches
# the container.
set -eu

example=$(grep -oE '^#? ?RAFT_MANAGED_MCP_[A-Z_]+' deploy/docker/.env.example | sed 's/^#//; s/ //')
compose=$(sed -n '/^  server:/,/^  [a-z]/p' deploy/docker/docker-compose.yml | grep -oE 'RAFT_MANAGED_MCP_[A-Z_]+' | sort -u)

status=0
for var in $example; do
  case "$compose" in
    *"$var"*) ;;
    *)
      echo "check-compose-env-coverage: $var is documented in .env.example but NOT passed through the compose server environment" >&2
      status=1
      ;;
  esac
done
exit $status
