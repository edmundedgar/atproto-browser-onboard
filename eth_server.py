#!/usr/bin/env python3
"""
Static file server for the atproto onboarding tool - every route here,
including client-metadata.json, just hands back a file from disk. Domain
setup (domain.html) talks to Ethereum/DNS directly from the browser - see
domain.html's own comments - so this has nothing domain-specific left to
do either.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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


@app.get("/client-metadata.json")
async def serve_client_metadata():
    # atproto OAuth client ID metadata document - client_id inside the file
    # must equal the exact URL it's served from, so this is a static file
    # baked for https://ens.goat.navy rather than computed per-request.
    # Its "scope" field must stay byte-identical to oauth-popup.html's own
    # OAUTH_SCOPE constant - see the comment there for why.
    #
    # Testing a scope/redirect_uri change against a real authorization
    # server sometimes needs a fresh client_id to dodge its cache of the
    # old document - copy this file to client-metadata/<tag>.json and
    # change client_id to .../client-metadata/<tag>.json inside it, then
    # add a matching FileResponse route here.
    return FileResponse("client-metadata.json", media_type="application/json")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=38000)
