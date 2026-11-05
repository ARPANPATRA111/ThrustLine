# Low-latency game server in India (free): Oracle Cloud Always Free

Why: SpacetimeDB Maincloud runs in Virginia, USA, about 250 ms round trip from India. A server in
Hyderabad or Mumbai is about 25–40 ms away. Oracle Cloud's "Always Free" tier includes small VMs in
both regions at no cost, permanently. The game server is the same SpacetimeDB module; only its
location changes.

Measured from the developer's laptop (one round trip, TCP connect):

| Server | Round trip |
| --- | --- |
| Oracle Cloud Hyderabad (`ap-hyderabad-1`) | ~25 ms |
| Oracle Cloud Mumbai (`ap-mumbai-1`) | ~38 ms |
| AWS Mumbai | ~67 ms |
| Cloudflare Durable Object (routed via Singapore / Hong Kong / Tokyo) | 87–235 ms, varies per connection |
| SpacetimeDB Maincloud (Virginia, USA) | ~245–305 ms |

## 1. Create the VM (about 15 minutes, done once)

1. Sign up at https://www.oracle.com/cloud/free/ and choose **India South (Hyderabad)** or
   **India West (Mumbai)** as the home region. (A card is asked for identity verification;
   Always Free resources are not charged.)
2. Console → **Compute → Instances → Create instance**.
   - Image: **Canonical Ubuntu 22.04 or 24.04**.
   - Shape: **Ampere A1 Flex** (1 OCPU, 6 GB is plenty), or **VM.Standard.E2.1.Micro** if Ampere
     capacity is unavailable. Both are "Always Free eligible".
   - Networking: keep "Assign a public IPv4 address" on.
   - SSH keys: upload your public key (or let Oracle generate a pair and download it).
3. Open the firewall in Oracle's network: Instance → **Subnet → Security List → Add Ingress Rules**:
   source `0.0.0.0/0`, TCP, destination ports **80** and **443**.

## 2. Install the game server (one command)

From the repo folder on your laptop:

```bash
scp -i <key> deploy/oracle/setup-server.sh ubuntu@<public-ip>:~
ssh -i <key> ubuntu@<public-ip> "bash setup-server.sh"
```

The script installs SpacetimeDB as a system service, installs Caddy for a free automatic HTTPS
certificate on `<ip-with-dashes>.sslip.io` (no domain purchase needed), opens ports 80/443 in the
VM firewall, and prints the server URL.

## 3. Point the game at it and deploy

Edit `client/.env.production`:

```
VITE_STDB_URI=https://<ip-with-dashes>.sslip.io
VITE_STDB_DB=thrustline
```

Then run `npm run deploy`. It publishes the module to the new server and redeploys the client to
Vercel. To go back to Maincloud, restore the old two lines and deploy again.

## Notes

- Everyone connects to this one server, so players far from India will see higher ping. For a lab
  group in India that is ideal.
- Match data lives in memory/disk on the VM and is disposable, but `profile` and `season_board` hold
  every player's level and season points. Back them up, and copy them across when moving servers.
- Updates: `ssh ubuntu@<ip> "spacetime version upgrade && sudo systemctl restart spacetimedb"`.
- Logs: `ssh ubuntu@<ip> "journalctl -u spacetimedb -f"`.
