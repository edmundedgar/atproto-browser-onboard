#!/usr/bin/env bash
# Pins webroot/ to IPFS via Filebase and prints the resulting CID.
#
# Goes through Filebase's plain S3 API (a CAR upload with an `import=car`
# metadata flag, which tells Filebase to unpack and pin it) rather than their
# IPFS remote-pinning-service API. That second route needs Filebase's own
# nodes to dial back into a local `ipfs daemon` over libp2p to fetch the
# blocks, which silently never completes on a NAT'd/firewalled host with no
# inbound access to port 4001 - the pin request shows up in the Filebase
# dashboard ("sees it") but sits at Pinning-Status: pinning forever ("doesn't
# upload"). The CAR upload sidesteps that: the whole DAG travels in one HTTPS
# PUT, so Filebase has everything already and pins it immediately - no daemon,
# no open port, no P2P reachability needed at all.
#
# Credentials come from ~/secrets/filebase.sec, not this repo's .env (that
# file's FILEBASE_* vars are a leftover from a different, now-removed
# subsystem, pointed at a different bucket - see ETH_SERVER_README.md).
# filebase.sec holds the same base64-encoded ACCESS_KEY:SECRET_KEY:BUCKET
# string Filebase hands out for their S3 and pinning-service credentials.
#
# Usage: scripts/publish-to-ipfs.sh
# Env overrides: FILEBASE_SECRET_FILE, FILEBASE_OBJECT_KEY

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBROOT_DIR="$REPO_DIR/webroot"
VENV_PYTHON="$REPO_DIR/venv/bin/python3"
SECRET_FILE="${FILEBASE_SECRET_FILE:-$HOME/secrets/filebase.sec}"
OBJECT_KEY="${FILEBASE_OBJECT_KEY:-atproto-onboard-site.car}"

if ! command -v ipfs >/dev/null; then
    echo "ipfs (kubo) not found on PATH - install it first." >&2
    exit 1
fi
if [ ! -f "$SECRET_FILE" ]; then
    echo "No credentials at $SECRET_FILE" >&2
    exit 1
fi
if [ ! -x "$VENV_PYTHON" ]; then
    echo "No venv python at $VENV_PYTHON (needs boto3 - see requirements.txt)" >&2
    exit 1
fi

CREDS="$(base64 -d < "$SECRET_FILE")"
ACCESS_KEY="${CREDS%%:*}"
REST="${CREDS#*:}"
SECRET_KEY="${REST%%:*}"
BUCKET="${REST#*:}"

echo "Adding $WEBROOT_DIR to local IPFS repo..."
CID="$(ipfs add -r --cid-version=1 -Q "$WEBROOT_DIR")"
echo "CID: $CID"

CAR_FILE="$(mktemp --suffix=.car)"
trap 'rm -f "$CAR_FILE"' EXIT
ipfs dag export "$CID" > "$CAR_FILE"
echo "Exported CAR: $CAR_FILE ($(stat -c%s "$CAR_FILE") bytes)"

echo "Uploading to Filebase bucket \"$BUCKET\" as $OBJECT_KEY..."
"$VENV_PYTHON" - "$ACCESS_KEY" "$SECRET_KEY" "$BUCKET" "$OBJECT_KEY" "$CAR_FILE" "$CID" <<'PYEOF'
import sys
import boto3

access_key, secret_key, bucket, object_key, car_file, expected_cid = sys.argv[1:7]

s3 = boto3.client(
    's3',
    endpoint_url='https://s3.filebase.com',
    aws_access_key_id=access_key,
    aws_secret_access_key=secret_key,
)
s3.upload_file(car_file, bucket, object_key, ExtraArgs={'Metadata': {'import': 'car'}})

head = s3.head_object(Bucket=bucket, Key=object_key)
meta = head.get('Metadata', {})
returned_cid = meta.get('Cid') or meta.get('cid')
status = meta.get('Pinning-Status') or meta.get('pinning-status')
print(f"Filebase reports CID={returned_cid} status={status}")
if returned_cid != expected_cid:
    sys.exit(f"CID mismatch: expected {expected_cid}, Filebase returned {returned_cid}")
if status != 'pinned':
    sys.exit(f"Not pinned yet (status={status}) - rerun in a moment to check again")
PYEOF

echo
echo "Pinned: $CID"
echo "  https://ipfs.filebase.io/ipfs/$CID/"
echo "  https://$CID.ipfs.dweb.link/"

DEPLOY_DIR="$REPO_DIR/deploy"
mkdir -p "$DEPLOY_DIR"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{\n  "cid": "%s",\n  "publishedAt": "%s"\n}\n' "$CID" "$PUBLISHED_AT" > "$DEPLOY_DIR/cid.json"
echo
echo "Wrote $DEPLOY_DIR/cid.json - open deploy.html to set the ENS/GNS contenthash."
