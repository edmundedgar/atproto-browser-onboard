# ETH Domain ATProto DID Server

A FastAPI server that interfaces with .eth domains to query `.well-known/atproto-did` files through the `.eth.link` gateway. This server handles CORS to allow browser access from anywhere.

## Overview

This server provides a proxy service to check if ENS (Ethereum Name Service) domains have ATProto DID records configured. It queries the `.eth.link` gateway to fetch the `.well-known/atproto-did` file and validates the DID format.

## Installation

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

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

## Future Enhancements

- POST endpoint to create `.well-known/atproto-did` files (planned)
- Support for `.eth.limo` gateway as fallback
- Caching of successful lookups
- Retry logic with exponential backoff

