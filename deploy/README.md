# Moving the game to your own server

Production runs on SpacetimeDB Maincloud in Virginia, about 250 ms round trip from India. Your own
SpacetimeDB server in India runs the same module and only the location changes. Any Linux VM works,
from any provider.

Measured from the developer's laptop (one round trip, TCP connect):

| Server | Round trip |
| --- | --- |
| Oracle Cloud Hyderabad (`ap-hyderabad-1`) | ~25 ms |
| Oracle Cloud Mumbai (`ap-mumbai-1`) | ~38 ms |
| AWS Mumbai | ~67 ms |
| Cloudflare Durable Object (routed via Singapore / Hong Kong / Tokyo) | 87–235 ms, varies per connection |
| SpacetimeDB Maincloud (Virginia, USA) | ~245–305 ms |

## Before you start: what happens to player progress

A new server cannot read Maincloud's login tokens (it answers `401 InvalidSignature`), so every
player arrives there as a new identity and would lose their level. To carry progress across, each
player's browser keeps a private transfer key:

1. On connecting, a browser registers its key against that player's profile (`registerTransfer`).
2. `scripts/move-data.mjs export` pairs each key with its profile. `import` stores those rows on the
   new server in the private `legacy_profile` table.
3. The browser sends the same key to the new server on its first visit, and the module hands that
   profile to the new identity, once.

Two limits follow from this:

- **A player is only covered if they visited after transfer keys shipped.** The longer that release
  is live before the move, the more players carry over. Anyone else starts fresh on the new server.
- **The key lives in the browser, under the site's address.** Keep `thrustline-drab.vercel.app` as
  the player-facing URL through the move. A new domain would mean a new, empty `localStorage`.

Check coverage at any time. The export prints how many profiles have a key:

```bash
node scripts/move-data.mjs export maincloud thrustline-zhtm
```

## 1. Create the server

You need a small Ubuntu 22.04 or 24.04 VM with a public IPv4 address, in or near India, with TCP
ports 22, 80 and 443 open in the provider's firewall. Then, from the repo folder:

```bash
scp deploy/setup-server.sh <user>@<public-ip>:~
ssh <user>@<public-ip> "bash setup-server.sh"                   # free <ip-with-dashes>.sslip.io address
ssh <user>@<public-ip> "bash setup-server.sh game.example.com"  # or your own domain
```

The script installs SpacetimeDB as a system service and Caddy for an automatic HTTPS certificate,
opens ports 80 and 443 on the VM, and prints the server's address. Below it is `https://<host>`.

## 2. Publish the module there

Players are not affected yet: this only prepares the new server.

```bash
npm run typecheck && npm test
spacetime publish thrustline --server https://<host> --module-path server --yes
curl https://<host>/v1/ping
```

Whoever publishes first owns the database, so run this while logged in as yourself. Check it with a
real client before moving anyone:

```bash
VITE_STDB_URI=wss://<host> VITE_STDB_DB=thrustline npm run dev
```

## 3. Copy the progress, then switch

Do these together, so little progress is earned on Maincloud in between. The export file holds every
transfer key: never commit it (it is git-ignored) and delete it when you are done.

```bash
node scripts/move-data.mjs export maincloud thrustline-zhtm
node scripts/move-data.mjs import https://<host> thrustline
```

Edit `client/.env.production`:

```env
VITE_STDB_URI=https://<host>
VITE_STDB_DB=thrustline
```

Then `npm run deploy`. It publishes to the new server and redeploys the client. Players move over the
next time they load the page.

Running the export and import again later is safe: profiles already waiting are skipped. Do it once
more after a day or so to pick up players who were still on an old tab.

## 4. Check it

- Open the live site in a browser that has played before. Your level should be there.
- Run the live checks against production:
  `BASE_URL=https://thrustline-drab.vercel.app PLAYERS=2 npx playwright test tests/e2e/smoke.spec.ts tests/e2e/latency.spec.ts`
- Watch the first full room: `ssh <user>@<public-ip> "journalctl -u spacetimedb -f"`, with `top` beside it.

## Going back

Keep the Maincloud database for at least two weeks. To roll back, restore the two lines in
`client/.env.production` and run `npm run deploy`. Anything earned on the new server stays there.

## Running the server

- **Everyone connects to this one server**, so players far from it see a higher ping.
- **Backups:** `profile` and `season_board` hold every player's level and season points and cannot be
  rebuilt. Run the export from step 3 on a schedule against the new server, and keep the file private.
- **Updates:** `ssh <user>@<public-ip> "spacetime version upgrade && sudo systemctl restart spacetimedb"`.
- **Schema changes:** the same rule as Maincloud. Never pass `--delete-data`.

## Oracle Cloud Always Free

If you have a card for the signup, Oracle's Always Free tier covers this at no cost:

1. Sign up at <https://www.oracle.com/cloud/free/> with **India South (Hyderabad)** or **India West
   (Mumbai)** as the home region.
2. **Compute → Instances → Create instance**. Use Canonical Ubuntu with the **Ampere A1 Flex** shape
   (1 OCPU, 6 GB), or **VM.Standard.E2.1.Micro** if Ampere capacity is unavailable. Keep "Assign a
   public IPv4 address" on and upload your SSH key.
3. **Subnet → Security List → Add Ingress Rules**: source `0.0.0.0/0`, TCP, ports **80** and **443**.
