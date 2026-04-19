#!/usr/bin/env bash
set -euo pipefail

# Allowlist-based outbound firewall for headless Claude Code usage.
# Restricts outbound traffic to known-good domains only.
# Usage: /usr/local/bin/init-firewall.sh [--disable|--status|--list-sources]

SOURCES_FILE="/etc/oas/firewall-sources.tsv"
EXTRAS_FILE="/etc/oas/firewall-extras.txt"

case "${1:-}" in
  --disable)
    iptables -F OUTPUT 2>/dev/null || true
    iptables -P OUTPUT ACCEPT
    ipset destroy allowed_ips 2>/dev/null || true
    echo "Firewall disabled."
    exit 0
    ;;
  --status)
    if iptables -L OUTPUT -n 2>/dev/null | grep -q "DROP"; then
      echo "enabled"
    else
      echo "disabled"
    fi
    exit 0
    ;;
  --list-sources)
    if [ ! -f "$SOURCES_FILE" ]; then
      echo "(no firewall-sources file — firewall has not been initialized in this container)" >&2
      exit 1
    fi
    # Pretty-print grouped by source tag
    awk -F'\t' '{printf "[%-8s] %s\n", $1, $2}' "$SOURCES_FILE" | sort
    exit 0
    ;;
esac

BASELINE_DOMAINS=(
  # Anthropic
  api.anthropic.com
  statsig.anthropic.com
  sentry.io

  # npm
  registry.npmjs.org
  registry.yarnpkg.com

  # GitHub
  github.com
  api.github.com
  raw.githubusercontent.com
  objects.githubusercontent.com
  github-releases.githubusercontent.com
  cli.github.com

  # PyPI
  pypi.org
  files.pythonhosted.org

  # CDNs
  cdn.jsdelivr.net
  cdnjs.cloudflare.com
  unpkg.com

  # Ubuntu apt mirrors — for narrow sudo apt-get usage (see README)
  archive.ubuntu.com
  security.ubuntu.com
  ports.ubuntu.com
  keyserver.ubuntu.com
)

# Assemble the effective allowlist from three sources. Record each
# entry's origin for later inspection via --list-sources.
# Sources are additive — no override semantics, duplicates are harmless.
mkdir -p "$(dirname "$SOURCES_FILE")"
: > "$SOURCES_FILE"

declare -A SEEN
declare -a ALLOWED_DOMAINS=()

add_entry() {
  local tag="$1"
  local entry="$2"
  # Trim whitespace
  entry="${entry#"${entry%%[![:space:]]*}"}"
  entry="${entry%"${entry##*[![:space:]]}"}"
  [ -z "$entry" ] && return
  # Skip duplicates but record the additional source tag
  if [ -n "${SEEN[$entry]:-}" ]; then
    printf '%s\t%s\n' "$tag" "$entry" >> "$SOURCES_FILE"
    return
  fi
  SEEN[$entry]=1
  ALLOWED_DOMAINS+=("$entry")
  printf '%s\t%s\n' "$tag" "$entry" >> "$SOURCES_FILE"
}

# Baseline
for d in "${BASELINE_DOMAINS[@]}"; do
  add_entry baseline "$d"
done

# Plugin-supplied (comma-separated env var)
if [ -n "${OAS_ALLOWED_DOMAINS:-}" ]; then
  IFS=',' read -ra PLUGIN_EXTRAS <<< "$OAS_ALLOWED_DOMAINS"
  for d in "${PLUGIN_EXTRAS[@]}"; do
    add_entry plugin "$d"
  done
fi

# Host-managed file (read-only mount, invisible to Claude)
if [ -f "$EXTRAS_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip comments and trim
    line="${line%%#*}"
    add_entry file "$line"
  done < "$EXTRAS_FILE"
fi

# Build a temporary ipset, then atomically swap to avoid races
ipset create allowed_ips hash:net -exist
ipset create allowed_ips_new hash:net -exist
ipset flush allowed_ips_new

echo "Resolving domains..."
PIDS=()
for entry in "${ALLOWED_DOMAINS[@]}"; do
  # CIDR (e.g. 10.0.0.0/16) or bare IPv4 — add directly, no DNS needed.
  if [[ "$entry" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]]; then
    cidr="$entry"
    [[ "$cidr" != */* ]] && cidr="${cidr}/32"
    ipset add allowed_ips_new "$cidr" -exist
    continue
  fi
  (
    ips=$(dig +short A "$entry" 2>/dev/null | grep -E '^[0-9]+\.' || true)
    if [ -z "$ips" ]; then
      echo "WARNING: failed to resolve $entry" >&2
      exit 1
    fi
    for ip in $ips; do
      ipset add allowed_ips_new "${ip}/32" -exist
    done
  ) &
  PIDS+=($!)
done

FAILED=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || FAILED=$((FAILED + 1))
done

if [ "$FAILED" -gt 0 ]; then
  echo "WARNING: $FAILED domain(s) failed to resolve — firewall may have gaps" >&2
fi

# Aggregate into CIDR blocks if possible
if command -v aggregate &>/dev/null; then
  AGGREGATED=$(ipset list allowed_ips_new | grep -E '^[0-9]' | aggregate -q 2>/dev/null || true)
  if [ -n "$AGGREGATED" ]; then
    ipset flush allowed_ips_new
    while IFS= read -r cidr; do
      ipset add allowed_ips_new "$cidr" -exist
    done <<< "$AGGREGATED"
  fi
fi

# Atomically swap the ipset so iptables rules always reference a complete set
ipset swap allowed_ips_new allowed_ips
ipset destroy allowed_ips_new

# Flush existing OUTPUT rules (idempotent)
iptables -F OUTPUT 2>/dev/null || true

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# DNS — restrict to configured resolvers only (prevents DNS tunneling)
for ns in $(grep -oP 'nameserver \K[\d.]+' /etc/resolv.conf); do
  iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done

# Allow traffic to allowlisted IPs
iptables -A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 443 -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 80 -j ACCEPT

# Block cloud metadata endpoint
iptables -A OUTPUT -d 169.254.169.254 -j DROP

# Docker gateway — always allowed (for container networking)
GATEWAY=$(ip route | awk '/default/ {print $3}')
[ -n "$GATEWAY" ] && iptables -A OUTPUT -d "$GATEWAY" -j ACCEPT

# Obsidian MCP host — resolve host.docker.internal and allow the MCP port.
# When OAS_HOST_IP is set, entrypoint.sh rewrites /etc/hosts so
# host.docker.internal points to the Windows host rather than the Docker
# bridge gateway. That IP is not covered by the gateway rule above.
OAS_HOST=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1; exit}')
if [ -n "$OAS_HOST" ] && [ "$OAS_HOST" != "$GATEWAY" ]; then
    iptables -A OUTPUT -d "$OAS_HOST" -p tcp --dport "${OAS_MCP_PORT:-28080}" -j ACCEPT
fi

# Configurable private hosts (NAS, local services, etc.)
if [ -n "${ALLOWED_PRIVATE_HOSTS:-}" ]; then
  IFS=',' read -ra HOSTS <<< "$ALLOWED_PRIVATE_HOSTS"
  for host in "${HOSTS[@]}"; do
    # Trim whitespace using bash parameter expansion (safer than xargs)
    host="${host#"${host%%[![:space:]]*}"}"
    host="${host%"${host##*[![:space:]]}"}"
    [ -n "$host" ] && iptables -A OUTPUT -d "$host" -j ACCEPT
  done
fi

# Drop everything else
iptables -A OUTPUT -j DROP

echo "Firewall active. $(ipset list allowed_ips | grep -c '^[0-9]') IP entries allowlisted."
echo "To disable: /usr/local/bin/init-firewall.sh --disable"
