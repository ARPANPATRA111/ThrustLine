#!/usr/bin/env bash
# One-shot setup of a THRUSTLINE game server on a fresh Ubuntu VM from any provider. Installs
# SpacetimeDB as a service and Caddy for HTTPS/WSS. See deploy/README.md for the whole move.
#
# Run on the VM as a user with sudo:
#   bash setup-server.sh            # uses <public-ip>.sslip.io as the hostname (free, no domain needed)
#   bash setup-server.sh game.example.com   # or your own domain pointing at the VM
#
set -euo pipefail

PUBLIC_IP="$(curl -s https://api.ipify.org)"
HOST="${1:-$(echo "$PUBLIC_IP" | tr . -).sslip.io}"
echo "==> Public IP: $PUBLIC_IP   Hostname: $HOST"

# 1. SpacetimeDB (official installer; x86_64 and arm64 Linux are both supported).
if ! command -v spacetime >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/spacetime" ]; then
  echo "==> Installing SpacetimeDB"
  curl -sSf https://install.spacetimedb.com | sh -s -- --yes
fi
SPACETIME="$(command -v spacetime || echo "$HOME/.local/bin/spacetime")"
"$SPACETIME" --version

# 2. Run SpacetimeDB as a service, listening only on localhost (Caddy is the public front door).
echo "==> Creating the spacetimedb service"
sudo tee /etc/systemd/system/spacetimedb.service >/dev/null <<EOF
[Unit]
Description=SpacetimeDB (THRUSTLINE game server)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
ExecStart=$SPACETIME start --listen-addr 127.0.0.1:3000 --non-interactive
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now spacetimedb

# 3. Caddy: automatic Let's Encrypt certificate, HTTPS + WebSocket reverse proxy.
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  sudo apt-get update -y
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$HOST {
  # WebSocket upgrades are proxied automatically.
  reverse_proxy 127.0.0.1:3000
}
EOF

# 4. Open ports 80 (certificate challenge) and 443 (game traffic) in the VM firewall.
#    Some images (Oracle's Ubuntu among them) ship iptables rules that reject everything but SSH.
echo "==> Opening ports 80 and 443"
sudo iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true

sudo systemctl restart caddy
sleep 5
echo "==> Checking https://$HOST/v1/ping"
if curl -sf "https://$HOST/v1/ping" >/dev/null; then
  echo "OK: SpacetimeDB is reachable at https://$HOST"
else
  echo "Not reachable yet. Make sure your provider's firewall allows TCP 80 and 443 from anywhere,"
  echo "then run: sudo systemctl restart caddy && curl -v https://$HOST/v1/ping"
fi
echo
echo "Next: follow deploy/README.md from step 2, with https://$HOST as the new server."
