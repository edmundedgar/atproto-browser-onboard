# ETH Domain ATProto DID Server

A FastAPI server that interfaces with .eth domains to query `.well-known/atproto-did` files through the `.eth.link` gateway. This server handles CORS to allow browser access from anywhere.

## Overview

This server provides a proxy service to check if ENS (Ethereum Name Service) domains have ATProto DID records configured. It queries the `.eth.link` gateway to fetch the `.well-known/atproto-did` file and validates the DID format.

## Installation

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. Create a `.env` file in the project root with your Filebase credentials:
```bash
FILEBASE_ACCESS_KEY=your_access_key_here
FILEBASE_SECRET_KEY=your_secret_key_here
FILEBASE_BUCKET=atproto-did
FILEBASE_ENDPOINT=https://s3.filebase.com
```

   The `.env` file should be added to `.gitignore` to keep your credentials secure.

## Running the Server

### Development Mode

Run directly:
```bash
python eth_server.py
```

Or with uvicorn:
```bash
uvicorn eth_server:app --host 127.0.0.1 --port 8000
```

The server will listen on `http://127.0.0.1:8000`

### Production Mode

For production, use uvicorn with workers:
```bash
uvicorn eth_server:app --host 127.0.0.1 --port 8000 --workers 4
```

## Nginx Configuration

To serve the server publicly over HTTPS, configure nginx as a reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /path/to/certificate.crt;
    ssl_certificate_key /path/to/private.key;
    
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## API Endpoints

### GET `/atproto-did/{domain}`

Query the ATProto DID for an ENS domain.

**Parameters:**
- `domain` (path): The ENS domain, e.g., `example.eth` or `bot.reality.eth`

**Response Format:**
```json
{
  "success": true,
  "did": "did:plc:u4d5v5zsl5jb2y33vtfhyjo5",
  "error": null,
  "errorType": null
}
```

**Success Response (200):**
- `success`: `true`
- `did`: The DID string from the `.well-known/atproto-did` file
- `error`: `null`
- `errorType`: `null`

**Error Response (200):**
- `success`: `false`
- `did`: `null`
- `error`: Error message describing what went wrong
- `errorType`: One of:
  - `"no_domain"`: ENS domain is not registered
  - `"invalid_did"`: Domain exists but DID is invalid or file is empty
  - `"gateway_failure"`: Unable to query the gateway (timeout, network error, etc.)

**Example Requests:**
```bash
# Query a root domain
curl http://127.0.0.1:8000/atproto-did/example.eth

# Query a subdomain
curl http://127.0.0.1:8000/atproto-did/bot.reality.eth
```

**Example Responses:**

Success:
```json
{
  "success": true,
  "did": "did:plc:u4d5v5zsl5jb2y33vtfhyjo5",
  "error": null,
  "errorType": null
}
```

Domain not found:
```json
{
  "success": false,
  "did": null,
  "error": "ENS domain 'nonexistent.eth' is not registered",
  "errorType": "no_domain"
}
```

Invalid DID:
```json
{
  "success": false,
  "did": null,
  "error": "ENS domain 'example.eth' exists but .well-known/atproto-did content is not a valid DID: invalid-content",
  "errorType": "invalid_did"
}
```

Gateway failure:
```json
{
  "success": false,
  "did": null,
  "error": "Timeout while querying gateway for 'example.eth'",
  "errorType": "gateway_failure"
}
```

### POST `/atproto-did/{domain}`

Create and pin a `.well-known/atproto-did` file for an ENS domain.

**Parameters:**
- `domain` (path): The ENS domain, e.g., `example.eth` or `bot.reality.eth`

**Request Body:**
```json
{
  "domain": "example.eth",
  "did": "did:plc:u4d5v5zsl5jb2y33vtfhyjo5"
}
```

**Response Format:**
```json
{
  "success": true,
  "ipfs_hash": "Qm...",
  "error": null,
  "errorType": null
}
```

**Success Response (200):**
- `success`: `true`
- `ipfs_hash`: The IPFS hash/CID of the pinned file
- `error`: `null`
- `errorType`: `null`

**Error Responses:**

File already exists with same DID (200):
```json
{
  "success": false,
  "ipfs_hash": null,
  "error": "File already exists with the same DID: did:plc:...",
  "errorType": "already_exists"
}
```

File already exists with different DID (200):
```json
{
  "success": false,
  "ipfs_hash": null,
  "error": "File already exists with different DID: did:plc:...",
  "errorType": "conflict"
}
```

Invalid DID format (400):
```json
{
  "success": false,
  "ipfs_hash": null,
  "error": "Invalid DID format: invalid-did",
  "errorType": "invalid_did"
}
```

Pin failure (500):
```json
{
  "success": false,
  "ipfs_hash": null,
  "error": "Failed to pin to Filebase: ...",
  "errorType": "pin_failure"
}
```

**Example Request:**
```bash
curl -X POST http://127.0.0.1:8000/atproto-did/example.eth \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "example.eth",
    "did": "did:plc:u4d5v5zsl5jb2y33vtfhyjo5"
  }'
```

**Behavior:**
1. Checks if a `.well-known/atproto-did` file already exists for the domain
2. If it exists with the same DID, returns an error
3. If it exists with a different DID, returns a conflict error
4. If it doesn't exist, creates the file with the provided DID
5. Pins the file to IPFS via Filebase
6. Returns the IPFS hash/CID

### GET `/health`

Health check endpoint.

**Response:**
```json
{
  "status": "healthy"
}
```

## Error Handling

The server handles the following scenarios:

1. **Domain not registered**: Returns `errorType: "no_domain"` when the ENS domain doesn't exist
2. **Invalid DID**: Returns `errorType: "invalid_did"` when the file exists but contains invalid DID syntax
3. **Gateway failure**: Returns `errorType: "gateway_failure"` when the `.eth.link` gateway is unreachable or times out (10-second timeout)
4. **Empty file**: Returns `errorType: "invalid_did"` when the file exists but is empty

## CORS

The server is configured to allow CORS requests from any origin, making it accessible from browser applications hosted anywhere.

## Timeout

The server uses a 10-second timeout for gateway requests. No automatic retries are performed - retry logic should be handled by the client.

## DID Validation

The server validates DID syntax using a regex pattern: `^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$`

This ensures the DID follows the basic format: `did:method:identifier`

## Filebase Configuration

The server uses Filebase (S3-compatible API) to pin files to IPFS. To use the POST endpoint:

1. Create a Filebase account at https://filebase.com
2. **Create an S3-compatible bucket** in the Filebase dashboard (e.g., `atproto-did`)
   - The bucket must be created manually before using the server
   - The server will not create the bucket automatically
3. Get your access key and secret key from Filebase dashboard
4. Add them to your `.env` file:
   ```
   FILEBASE_ACCESS_KEY=your_access_key
   FILEBASE_SECRET_KEY=your_secret_key
   FILEBASE_BUCKET=atproto-did
   FILEBASE_ENDPOINT=https://s3.filebase.com
   ```
   
   **Note:** Make sure the `FILEBASE_BUCKET` value matches the bucket name you created in Filebase.

## Future Enhancements

- Support for `.eth.limo` gateway as fallback
- Caching of successful lookups
- Retry logic with exponential backoff
- Better IPFS hash retrieval from Filebase
- Better IPFS hash retrieval from Filebase

