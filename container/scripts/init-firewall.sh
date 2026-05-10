#!/usr/bin/env bash
set -euo pipefail

# Allowlist-based outbound firewall for headless Claude Code usage.
# Restricts outbound traffic to known-good domains only.
# Usage: /usr/local/bin/init-firewall.sh [--disable|--status|--list-sources]

SOURCES_FILE="/etc/oas/firewall-sources.tsv"
EXTRAS_FILE="/etc/oas/firewall-extras.txt"
LOCK_FILE="/var/lock/oas-firewall.lock"

# Serialise concurrent invocations. The plugin can re-init while a manual
# `init-firewall.sh` is running, which would race the ipset swap and leave
# the OUTPUT chain attached to a half-built set. flock with -n bails fast
# rather than queueing — the second caller's intent is already satisfied
# by the first.
# --disable / --status / --list-sources don't mutate the active ruleset
# in conflicting ways, so they skip the lock to stay responsive.
case "${1:-}" in
  --disable|--status|--list-sources) ;;
  *)
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      echo "init-firewall.sh: another instance is already running ($LOCK_FILE)" >&2
      exit 1
    fi
    ;;
esac

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

_trim() {
  local s="$1"
  # Strip CR (handles CRLF line endings from Windows-edited files like
  # firewall-extras.txt) before whitespace trimming.
  s="${s//$'\r'/}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Validate an IPv4 octet (0-255).
_is_valid_octet() {
  local n="$1"
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  (( n >= 0 && n <= 255 ))
}

# Returns 0 if "$1" is a valid IPv4 address or IPv4 CIDR. Hostnames rejected.
_is_ipv4_or_cidr() {
  local entry="$1"
  local addr="$entry"
  local prefix=""
  if [[ "$entry" == */* ]]; then
    addr="${entry%/*}"
    prefix="${entry#*/}"
    [[ "$prefix" =~ ^[0-9]+$ ]] || return 1
    (( prefix >= 0 && prefix <= 32 )) || return 1
  fi
  local IFS=.
  # shellcheck disable=SC2206
  local parts=( $addr )
  [ "${#parts[@]}" -eq 4 ] || return 1
  local p
  for p in "${parts[@]}"; do
    _is_valid_octet "$p" || return 1
  done
  return 0
}

add_entry() {
  local tag="$1"
  local entry
  entry="$(_trim "$2")"
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

# Fail closed: set OUTPUT policy to DROP *before* DNS resolution. Without
# this, a baseline DNS failure aborts via `exit 1` while OUTPUT is still
# default-ACCEPT (first-run case), silently leaving the container wide open.
# The brief window between this and the rule-rebuild below is acceptable —
# the lock prevents concurrent invocations from racing the policy flip.
iptables -P OUTPUT DROP

# Build a temporary ipset, then atomically swap to avoid races
ipset create allowed_ips hash:net -exist
ipset create allowed_ips_new hash:net -exist
ipset flush allowed_ips_new

echo "Resolving domains..."
# Track baseline domains separately so a failure to resolve one (e.g.
# api.anthropic.com) is treated as a hard error rather than a silent gap.
# Plugin/file-supplied entries can fail safely with a warning — the user
# may have typo'd a domain or be working offline.
declare -A IS_BASELINE
for d in "${BASELINE_DOMAINS[@]}"; do IS_BASELINE[$d]=1; done

PIDS=()
PID_DOMAIN=()
PID_TIER=()
for entry in "${ALLOWED_DOMAINS[@]}"; do
  # CIDR (e.g. 10.0.0.0/16) or bare IPv4 — add directly, no DNS needed.
  # Octet bounds and prefix length are validated by _is_ipv4_or_cidr;
  # the simple shape regex below is just to route CIDR-shaped entries
  # away from DNS resolution.
  if [[ "$entry" =~ ^[0-9]+(\.[0-9]+){3}(/[0-9]+)?$ ]]; then
    if _is_ipv4_or_cidr "$entry"; then
      cidr="$entry"
      [[ "$cidr" != */* ]] && cidr="${cidr}/32"
      ipset add allowed_ips_new "$cidr" -exist
    else
      echo "WARNING: skipping invalid IPv4/CIDR entry: $entry" >&2
    fi
    continue
  fi
  (
    set -e
    ips=$(dig +time=2 +tries=1 +short A "$entry" 2>/dev/null | grep -E '^[0-9]+\.' || true)
    if [ -z "$ips" ]; then
      exit 1
    fi
    for ip in $ips; do
      ipset add allowed_ips_new "${ip}/32" -exist
    done
  ) &
  PIDS+=($!)
  PID_DOMAIN+=("$entry")
  if [ -n "${IS_BASELINE[$entry]:-}" ]; then
    PID_TIER+=("baseline")
  else
    PID_TIER+=("optional")
  fi
done

BASELINE_FAILED=0
OPTIONAL_FAILED=0
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  if ! wait "$pid"; then
    domain="${PID_DOMAIN[$i]}"
    tier="${PID_TIER[$i]}"
    if [ "$tier" = "baseline" ]; then
      echo "ERROR: failed to resolve baseline domain $domain" >&2
      BASELINE_FAILED=$((BASELINE_FAILED + 1))
    else
      echo "WARNING: failed to resolve $domain ($tier)" >&2
      OPTIONAL_FAILED=$((OPTIONAL_FAILED + 1))
    fi
  fi
done

if [ "$BASELINE_FAILED" -gt 0 ]; then
  echo "ERROR: $BASELINE_FAILED baseline domain(s) failed to resolve — refusing to apply firewall with required gaps" >&2
  ipset destroy allowed_ips_new 2>/dev/null || true
  exit 1
fi
if [ "$OPTIONAL_FAILED" -gt 0 ]; then
  echo "WARNING: $OPTIONAL_FAILED optional domain(s) failed to resolve — firewall applied without them" >&2
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

# Flush existing OUTPUT rules (idempotent). Capture stderr so we can
# distinguish "no rules to flush" (fine) from "iptables broken" (fatal —
# subsequent rule appends would silently attach to nothing).
flush_err=$(iptables -F OUTPUT 2>&1 >/dev/null) || {
  echo "ERROR: iptables -F OUTPUT failed: $flush_err" >&2
  exit 1
}

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# DNS — restrict to configured resolvers only (prevents DNS tunneling)
for ns in $(grep -oP 'nameserver \K[\d.]+' /etc/resolv.conf); do
  iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done

# Block cloud metadata endpoint BEFORE the allowlist ACCEPTs — defense in depth
# in case 169.254.169.254 ever ends up in allowed_ips by mistake.
iptables -A OUTPUT -d 169.254.169.254 -j DROP

# Allow traffic to allowlisted IPs
iptables -A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 443 -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 80 -j ACCEPT

# Docker gateway — restricted to HTTP/HTTPS and the MCP port. Previously
# this rule allowed *all* ports to the gateway; that was effectively a
# wide-open hole because in NAT mode the gateway is also the path to
# the host's MCP listener and any other host service. Narrow it to the
# same ports the rest of the allowlist uses.
MCP_PORT="${OAS_MCP_PORT:-28080}"
GATEWAY=$(ip route | awk '/default/ {print $3}')
if [ -n "$GATEWAY" ]; then
  iptables -A OUTPUT -d "$GATEWAY" -p tcp --dport 80 -j ACCEPT
  iptables -A OUTPUT -d "$GATEWAY" -p tcp --dport 443 -j ACCEPT
  iptables -A OUTPUT -d "$GATEWAY" -p tcp --dport "$MCP_PORT" -j ACCEPT
fi

# Obsidian MCP host — resolve host.docker.internal and allow the MCP port.
# Always append the MCP-port rule even when host.docker.internal == gateway:
# the gateway rule above is now port-scoped, so this rule keeps MCP working
# regardless of whether host.docker.internal resolves to the gateway IP or
# to a separately mapped host adapter (WSL2 mirrored mode).
OAS_HOST=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1; exit}')
if [ -n "$OAS_HOST" ]; then
    iptables -A OUTPUT -d "$OAS_HOST" -p tcp --dport "$MCP_PORT" -j ACCEPT
fi

# Configurable private hosts (NAS, local services, etc.). Accepts IPv4 or
# IPv4/CIDR ONLY — hostnames are rejected because we cannot safely resolve
# them here (the firewall is what restricts DNS in the first place) and
# silently ignoring them would surprise the operator. Restricted to the
# same ports as the domain allowlist + the MCP port.
if [ -n "${ALLOWED_PRIVATE_HOSTS:-}" ]; then
  IFS=',' read -ra HOSTS <<< "$ALLOWED_PRIVATE_HOSTS"
  for host in "${HOSTS[@]}"; do
    host="$(_trim "$host")"
    [ -z "$host" ] && continue
    if ! _is_ipv4_or_cidr "$host"; then
      echo "ERROR: ALLOWED_PRIVATE_HOSTS entry '$host' is not a valid IPv4 address or CIDR — hostnames are not accepted here. Skipping." >&2
      continue
    fi
    iptables -A OUTPUT -d "$host" -p tcp --dport 80 -j ACCEPT
    iptables -A OUTPUT -d "$host" -p tcp --dport 443 -j ACCEPT
    iptables -A OUTPUT -d "$host" -p tcp --dport "$MCP_PORT" -j ACCEPT
  done
fi

# Drop everything else
iptables -A OUTPUT -j DROP

echo "Firewall active. $(ipset list allowed_ips | grep -c '^[0-9]') IP entries allowlisted."
echo "To disable: /usr/local/bin/init-firewall.sh --disable"
