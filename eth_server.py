#!/usr/bin/env python3
"""
Static file server for the atproto onboarding tool, plus its OAuth client
metadata endpoints. Domain setup (domain.html) talks to Ethereum/DNS
directly from the browser - see domain.html's own comments - so this has
nothing domain-specific left to do.
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

app = FastAPI(title="atproto-browser-onboard static server")

# Configure CORS to allow requests from anywhere
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def serve_index():
    return FileResponse("index.html")


@app.get("/domain.html")
async def serve_domain():
    return FileResponse("domain.html")


@app.get("/bootstrap-config.js")
async def serve_bootstrap_config():
    return FileResponse("bootstrap-config.js", media_type="application/javascript")


@app.get("/social-import-config.js")
async def serve_social_import_config():
    return FileResponse("social-import-config.js", media_type="application/javascript")


@app.get("/oauth-popup.html")
async def serve_oauth_popup():
    return FileResponse("oauth-popup.html")


@app.get("/domain.css")
async def serve_domain_css():
    return FileResponse("domain.css", media_type="text/css")


@app.get("/oauth-popup.css")
async def serve_oauth_popup_css():
    return FileResponse("oauth-popup.css", media_type="text/css")


def _client_metadata_document(client_id: str, base: str) -> dict:
    return {
        "client_id": client_id,
        "client_name": "atproto PDS migration tool",
        "client_uri": base,
        "redirect_uris": [f"{base}/oauth-popup.html"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        # Every rpc:<lxm>?aud=* entry matches exactly one XRPC call in
        # oauth-popup.html - keep this in sync with that file's OAUTH_SCOPE
        # constant (must be the identical string: the reference PDS
        # implementation requires an exact match against what's requested
        # per-authorization, no wildcard leniency). Not transition:generic +
        # identity:* (the previous approach) because some PDS
        # implementations (tranquil-pds) reject mixing the legacy
        # transition:* scope with granular ones, per the atproto OAuth scope
        # spec - others (cocoon, the reference PDS) just don't enforce it.
        "scope": (
            "atproto identity:* "
            "rpc:com.atproto.identity.updateHandle?aud=* "
            "rpc:com.atproto.identity.getRecommendedDidCredentials?aud=* "
            "rpc:com.atproto.identity.requestPlcOperationSignature?aud=* "
            "rpc:com.atproto.identity.signPlcOperation?aud=* "
            "rpc:com.atproto.server.getServiceAuth?aud=* "
            "rpc:com.atproto.server.deactivateAccount?aud=* "
            "rpc:app.bsky.actor.getPreferences?aud=*"
        ),
        "application_type": "web",
        "token_endpoint_auth_method": "none",
        "dpop_bound_access_tokens": True,
    }


@app.get("/client-metadata.json")
async def serve_client_metadata(request: Request):
    # atproto OAuth client ID metadata document - client_id must equal the
    # exact URL this is served from. No client secret (public client using
    # PKCE + DPoP instead), so token_endpoint_auth_method is "none".
    base = str(request.base_url).rstrip("/")
    return JSONResponse(_client_metadata_document(f"{base}/client-metadata.json", base))


@app.get("/client-metadata/{tag}.json")
async def serve_client_metadata_tagged(request: Request, tag: str):
    # Same document under a distinct path, self-referential on whatever tag
    # is requested. Exists so a fresh client_id can be picked during testing
    # without waiting out an authorization server's cache of the untagged one.
    base = str(request.base_url).rstrip("/")
    return JSONResponse(_client_metadata_document(f"{base}/client-metadata/{tag}.json", base))


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=38000)
