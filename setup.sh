#!/usr/bin/env bash
# Flowsta Community Node setup.
#
#   ./setup.sh              basic node (DHT redundancy)
#   ./setup.sh bootstrap    basic node + open bootstrap/relay role
#
# Safe to re-run; it never overwrites an existing config.
set -euo pipefail

ROLE="${1:-basic}"
API_URL_DEFAULT="https://auth-api.flowsta.com"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── prerequisites ────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install it first: https://get.docker.com"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command)."
docker info >/dev/null 2>&1 || fail "Cannot talk to Docker. Is the daemon running, and is your user in the 'docker' group? (sudo usermod -aG docker \$USER, then log out and back in)"

# ── config ───────────────────────────────────────────────────────────
# The conductor config is no longer a file you keep: the agent renders one
# per Holochain generation from the signed manifest. Your settings live in
# .env (see "Configuration reference" in the README).
if [ -f conductor-config.yaml ] && ! grep -q "^BOOTSTRAP_AUTH_MATERIAL=" .env 2>/dev/null; then
  say "Found a conductor-config.yaml from the previous node version; the agent carries its auth material over on first run and renders configs from the manifest from then on."
fi

if [ ! -f .env ]; then
  {
    echo "API_URL=${API_URL_DEFAULT}"
    echo "CHANNEL=stable"
    echo "TZ=$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
    echo "UPDATE_WINDOW=03:00-05:00"
  } > .env
  say "Created .env: production network, stable channel, maintenance window 03:00-05:00 local time."
fi

# ── bootstrap role extras ────────────────────────────────────────────
if [ "$ROLE" = "bootstrap" ]; then
  say "Bootstrap role setup"

  # CGNAT check: if your router's WAN address is in 100.64.0.0/10 (or private
  # ranges), inbound connections cannot reach you and the bootstrap role
  # cannot work until your ISP gives you a public IP.
  PUBIP=$(curl -fsS https://api.ipify.org 2>/dev/null || true)
  if [ -n "$PUBIP" ]; then
    echo "Your public IP (as the internet sees you): $PUBIP"
    echo "Check your ROUTER's WAN address. If it differs from the IP above,"
    echo "or starts with 100.64-100.127 / 10. / 192.168., you are behind"
    echo "CGNAT and must ask your ISP for a public IP before continuing."
    read -rp "Does your router's WAN address match ${PUBIP}? [y/N] " OK
    case "$OK" in [yY]*) ;; *) fail "Resolve CGNAT with your ISP first (a 'public/static IP' option or a support request), then re-run." ;; esac
  fi

  read -rp "Domain name for this node (e.g. node2.example.com): " DOMAIN
  [ -n "$DOMAIN" ] || fail "A domain is required for the bootstrap role."
  RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
  if [ -n "$PUBIP" ] && [ "$RESOLVED" != "$PUBIP" ]; then
    echo "WARNING: $DOMAIN resolves to '${RESOLVED:-nothing}' but your public IP is $PUBIP."
    echo "Create/point the DNS A record and make sure ports 80 and 443 are forwarded to this machine."
    read -rp "Continue anyway? [y/N] " OK
    case "$OK" in [yY]*) ;; *) exit 1 ;; esac
  fi

  if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    command -v certbot >/dev/null 2>&1 || { say "Installing certbot..."; sudo apt-get update -qq && sudo apt-get install -y -qq certbot; }
    say "Requesting a TLS certificate for $DOMAIN (port 80 must be free and forwarded)..."
    sudo certbot certonly --standalone -d "$DOMAIN"
  else
    say "Certificate for $DOMAIN already exists - reusing it."
  fi

  grep -q '^TLS_DOMAIN=' .env 2>/dev/null || echo "TLS_DOMAIN=$DOMAIN" >> .env
  say "Starting node + bootstrap role..."
  docker compose --profile bootstrap up -d
  say "Done. Verify from anywhere:  curl -s https://$DOMAIN/"
else
  say "Starting node..."
  docker compose up -d
fi

# ── verify ───────────────────────────────────────────────────────────
say "Node is starting. Give it a minute, then verify it joined the network:"
echo "  docker compose logs -f agent          # manifest accepted, conductors created, DNAs installed (checksum-verified)"
echo "  curl -s localhost:8787/status.json    # what the node runs, what it is waiting for"
echo "  docker exec flowsta-sidecar node /app/updater/dht-update.mjs   # force an update pass"
echo
echo "Your node syncs the network's public data over the next hours. Thank you"
echo "for adding resilience to the Flowsta network."
