#!/usr/bin/env bash
set -euo pipefail

# Allowlist-based outbound firewall for headless Claude Code usage.
# Restricts outbound traffic to known-good domains only.
# Usage: sudo /usr/local/bin/init-firewall.sh

ALLOWED_DOMAINS=(
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
)

# Create or flush the ipset
ipset create allowed_ips hash:net -exist
ipset flush allowed_ips

echo "Resolving domains..."
for domain in "${ALLOWED_DOMAINS[@]}"; do
  (
    ips=$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.' || true)
    if [ -z "$ips" ]; then
      echo "WARNING: failed to resolve $domain" >&2
    else
      for ip in $ips; do
        ipset add allowed_ips "${ip}/32" -exist
      done
    fi
  ) &
done
wait

# Aggregate into CIDR blocks if possible
if command -v aggregate &>/dev/null; then
  AGGREGATED=$(ipset list allowed_ips | grep -E '^[0-9]' | aggregate -q 2>/dev/null || true)
  if [ -n "$AGGREGATED" ]; then
    ipset flush allowed_ips
    while IFS= read -r cidr; do
      ipset add allowed_ips "$cidr" -exist
    done <<< "$AGGREGATED"
  fi
fi

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

# Docker gateway — always allowed (for host.docker.internal)
GATEWAY=$(ip route | awk '/default/ {print $3}')
[ -n "$GATEWAY" ] && iptables -A OUTPUT -d "$GATEWAY" -j ACCEPT

# Configurable private hosts (NAS, local services, etc.)
if [ -n "${ALLOWED_PRIVATE_HOSTS:-}" ]; then
  IFS=',' read -ra HOSTS <<< "$ALLOWED_PRIVATE_HOSTS"
  for host in "${HOSTS[@]}"; do
    host=$(echo "$host" | xargs)
    [ -n "$host" ] && iptables -A OUTPUT -d "$host" -j ACCEPT
  done
fi

# Drop everything else
iptables -A OUTPUT -j DROP

echo "Firewall active. $(ipset list allowed_ips | grep -c '^[0-9]') IP entries allowlisted."
echo "To disable: iptables -F OUTPUT"
