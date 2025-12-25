#!/usr/bin/env python3
"""
Server for interfacing with .eth domains to query .well-known/atproto-did files.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
import re
from typing import Dict, Any

app = FastAPI(title="ETH Domain ATProto DID Server")

# Configure CORS to allow requests from anywhere
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# DID validation regex - basic check for did:method:identifier format
DID_PATTERN = re.compile(r'^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$')


def is_valid_did(did: str) -> bool:
    """Check if a string is a syntactically valid DID."""
    if not did:
        return False
    did = did.strip()
    return bool(DID_PATTERN.match(did))


async def query_eth_link_gateway(domain: str) -> Dict[str, Any]:
    """
    Query the .eth.link gateway for the .well-known/atproto-did file.
    
    Args:
        domain: The ENS domain (e.g., "example.eth" or "bot.reality.eth")
    
    Returns:
        Dict with 'success', 'did', 'error', and 'errorType' keys
    """
    # Construct the gateway URL
    gateway_url = f"https://{domain}.eth.link/.well-known/atproto-did/"
    
    try:
        # Make request with 10-second timeout
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(gateway_url)
            
            # Check if the domain exists (404 means domain not found)
            if response.status_code == 404:
                return {
                    "success": False,
                    "did": None,
                    "error": f"ENS domain '{domain}' is not registered",
                    "errorType": "no_domain"
                }
            
            # Check for other HTTP errors
            if not response.is_success:
                return {
                    "success": False,
                    "did": None,
                    "error": f"Gateway returned status {response.status_code}",
                    "errorType": "gateway_failure"
                }
            
            # Get the content
            content = response.text.strip()
            
            # Check if content is empty
            if not content:
                return {
                    "success": False,
                    "did": None,
                    "error": f"ENS domain '{domain}' exists but .well-known/atproto-did file is empty",
                    "errorType": "invalid_did"
                }
            
            # Validate DID syntax
            if not is_valid_did(content):
                return {
                    "success": False,
                    "did": None,
                    "error": f"ENS domain '{domain}' exists but .well-known/atproto-did content is not a valid DID: {content}",
                    "errorType": "invalid_did"
                }
            
            # Success - return the DID
            return {
                "success": True,
                "did": content,
                "error": None,
                "errorType": None
            }
            
    except httpx.TimeoutException:
        return {
            "success": False,
            "did": None,
            "error": f"Timeout while querying gateway for '{domain}'",
            "errorType": "gateway_failure"
        }
    except httpx.RequestError as e:
        return {
            "success": False,
            "did": None,
            "error": f"Failed to query gateway for '{domain}': {str(e)}",
            "errorType": "gateway_failure"
        }
    except Exception as e:
        return {
            "success": False,
            "did": None,
            "error": f"Unexpected error: {str(e)}",
            "errorType": "gateway_failure"
        }


@app.get("/atproto-did/{domain}")
async def get_atproto_did(domain: str) -> JSONResponse:
    """
    Get the ATProto DID from an ENS domain's .well-known/atproto-did file.
    
    Args:
        domain: The ENS domain (e.g., "example.eth" or "bot.reality.eth")
    
    Returns:
        JSON response with success status, DID, and error information
    """
    # Validate domain format (should end with .eth)
    if not domain.endswith('.eth'):
        raise HTTPException(
            status_code=400,
            detail="Domain must end with .eth"
        )
    
    # Query the gateway
    result = await query_eth_link_gateway(domain)
    
    # Return appropriate HTTP status based on result
    if result["success"]:
        return JSONResponse(content=result, status_code=200)
    else:
        # Return 200 with error info in JSON (not HTTP error)
        # This allows the client to handle different error types
        return JSONResponse(content=result, status_code=200)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

