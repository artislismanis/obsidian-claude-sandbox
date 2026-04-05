#!/bin/bash

echo "=== Agent Sandbox — Environment Verification ==="

echo "Node:    $(node --version 2>&1 || echo 'not found')"
echo "npm:     $(npm --version 2>&1 || echo 'not found')"
echo "git:     $(git --version 2>&1 || echo 'not found')"
echo "tmux:    $(tmux -V 2>&1 || echo 'not found')"
echo "ttyd:    $(ttyd --version 2>&1 | head -1 || echo 'not found')"
echo "jq:      $(jq --version 2>&1 || echo 'not found')"
echo "Claude:  $(claude --version 2>&1 || echo 'not found')"
echo "gh:      $(gh --version 2>&1 | head -1 || echo 'not found')"
echo "delta:   $(delta --version 2>&1 | head -1 || echo 'not found')"
echo "fzf:     $(fzf --version 2>&1 | head -1 || echo 'not found')"
echo "rg:      $(rg --version 2>&1 | head -1 || echo 'not found')"
echo "fd:      $(fd --version 2>&1 || echo 'not found')"
echo "atuin:   $(atuin --version 2>&1 || echo 'not found')"
echo "uv:      $(uv --version 2>&1 || echo 'not found')"
PY=$(uv python find 2>/dev/null) && echo "Python:  $($PY --version 2>&1)" || echo "Python:  not found"

echo ""
if [ -d "/workspace/vault" ] && [ "$(ls -A /workspace/vault 2>/dev/null)" ]; then
  VAULT_ITEMS=$(ls -1 /workspace/vault | wc -l)
  echo "Vault:   mounted at /workspace/vault (${VAULT_ITEMS} items)"
else
  echo "WARNING: No vault found at /workspace/vault"
  echo "  Set PKM_VAULT_PATH in .env and restart the container"
fi

if curl -sf http://localhost:7681/ > /dev/null 2>&1; then
  echo "ttyd:    listening on port 7681"
else
  echo "ttyd:    not yet listening (normal during build or exec)"
fi

echo ""
echo "To enable network sandboxing: sudo /usr/local/bin/init-firewall.sh"
echo "=== Done ==="
