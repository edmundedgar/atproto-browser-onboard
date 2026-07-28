# eth_server.py

A small FastAPI app that serves this project's static files, all of which
live in `webroot/` - `index.html`, `domain.html`, `oauth-popup.html`, their
CSS, `bootstrap-config.js`, `social-import-config.js`, and
`client-metadata.json` (the atproto OAuth client ID document - a real
static file, not computed per-request; see its own comment in
`eth_server.py` for why and how to mint a fresh tagged one for testing).
Every route is a plain `FileResponse` - nothing here is dynamic, so
`webroot/` is servable by any static file host on its own, with nothing
else in this repo (this script, tests/, docs) along for the ride. That's
deliberate: the eventual plan is to serve the app straight off IPFS via
`.eth`/`.gwei` content hashes, no server involved at all - `webroot/` is
exactly what would get pinned and published. Until then, this script
exists for local development and because the current live deployment
happens to reverse-proxy to it (see Nginx below).

## Domain setup (ENS/.eth, GNS/.gwei, custom domains)

There used to be a whole IPFS-pinning subsystem here (`/atproto-did/{domain}`,
Filebase, a local `ipfs` daemon) that generated a `.well-known/atproto-did`
file, pinned it, and pointed an ENS name's contenthash at it via
`.eth.link`. That's gone.

`domain.html` (opened as a popup from `index.html`, same as `oauth-popup.html`)
talks to Ethereum and DNS directly from the browser instead:

- For `.eth.xyz`: it sets a plain ENS text record (key `_atproto.`, value
  `did=<did>`) on the user's `.eth` name via a single `setText` transaction,
  using whatever wallet the browser has connected (MetaMask, etc.) - no
  server round-trip, no content to generate or pin.
  [eth.xyz](https://eth.xyz) republishes that text record as a real DNS
  TXT record at `_atproto.<name>.eth.xyz`, so `<name>.eth.xyz` works as
  an atproto handle exactly like a domain with a `_atproto` TXT record
  configured the ordinary way (this project's own handle resolution
  already checks DNS TXT records first, before falling back to
  `.well-known` HTTPS - see `resolveHandleToDid` in `index.html`).
- For `.gwei.name`: the same idea against [GNS](https://gwei.domains) (an
  ENS fork) instead of ENS itself - see the comments in `domain.html`'s
  GNS branch for the contract details.
- For any other custom domain the caller already controls: `domain.html`
  just shows the DNS TXT record / `.well-known/atproto-did` file to set up
  by hand - no wallet or on-chain step, since there's no registry to talk to.
- Reading back the current value (to check whether it's already set, and
  to what) is a plain `resolver.text(node, "_atproto.")` call (ENS/GNS) or
  a DNS/HTTPS lookup (custom domains), also from the browser - no server
  involved.

The ENS mechanism was verified against a real `.eth.xyz`-hosted atproto
account (`94086.eth.xyz`) before being built: its on-chain text record and
its live DNS TXT record both hold the exact same `did=...` value.

## Running

```bash
python eth_server.py
```

Needs no configuration - see `.env.example`.

The live deployment runs this as a systemd user service
(`~/.config/systemd/user/eth-onboard.service`, `Restart=always`) rather
than a bare process - use `systemctl --user restart eth-onboard.service`
to pick up changes, not a manual kill+relaunch. `Restart=always` means a
manually started process left running alongside it just occupies the
port and makes the service's own restarts fail silently (crash-loop) in
the background without it being obvious from the outside - `systemctl
--user status eth-onboard.service` shows which is actually true.

## Nginx

Same as any other reverse-proxied FastAPI app:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/certificate.crt;
    ssl_certificate_key /path/to/private.key;

    location / {
        proxy_pass http://127.0.0.1:38000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Endpoints

- `GET /`, `/domain.html`, `/oauth-popup.html`, `/domain.css`,
  `/oauth-popup.css`, `/bootstrap-config.js`, `/social-import-config.js`,
  `/client-metadata.json` - static files.
- `GET /health` - health check.
