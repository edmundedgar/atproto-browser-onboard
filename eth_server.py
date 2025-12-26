#!/usr/bin/env python3
"""
Server for interfacing with .eth domains to query .well-known/atproto-did files.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import httpx
import re
import os
import boto3
from botocore.exceptions import ClientError
from typing import Dict, Any
from dotenv import load_dotenv
from io import BytesIO

# Load environment variables from .env file
load_dotenv()

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

# Filebase configuration
FILEBASE_ACCESS_KEY = os.getenv('FILEBASE_ACCESS_KEY')
FILEBASE_SECRET_KEY = os.getenv('FILEBASE_SECRET_KEY')
FILEBASE_BUCKET = os.getenv('FILEBASE_BUCKET', 'atproto-did')
FILEBASE_ENDPOINT = os.getenv('FILEBASE_ENDPOINT', 'https://s3.filebase.com')

# Initialize Filebase S3 client
if FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY:
    s3_client = boto3.client(
        's3',
        endpoint_url=FILEBASE_ENDPOINT,
        aws_access_key_id=FILEBASE_ACCESS_KEY,
        aws_secret_access_key=FILEBASE_SECRET_KEY
    )
else:
    s3_client = None


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
    gateway_url = f"https://{domain}.link/.well-known/atproto-did/"
    
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


# Request model for POST endpoint
class CreateDidRequest(BaseModel):
    domain: str
    did: str


async def check_existing_did(domain: str, expected_did: str) -> Dict[str, Any]:
    """
    Check if a .well-known/atproto-did file already exists for the domain.
    
    Args:
        domain: The ENS domain
        expected_did: The DID to check for
    
    Returns:
        Dict with 'exists' and 'matches' keys
    """
    result = await query_eth_link_gateway(domain)
    
    if result["success"]:
        return {
            "exists": True,
            "matches": result["did"] == expected_did,
            "current_did": result["did"]
        }
    elif result["errorType"] == "no_domain":
        return {
            "exists": False,
            "matches": False,
            "current_did": None
        }
    else:
        # Gateway failure or invalid DID - treat as not existing
        return {
            "exists": False,
            "matches": False,
            "current_did": None
        }


async def pin_to_filebase(domain: str, did: str) -> Dict[str, Any]:
    """
    Create and pin a .well-known/atproto-did file to Filebase/IPFS.
    
    Args:
        domain: The ENS domain
        did: The DID to store
    
    Returns:
        Dict with 'success', 'ipfs_hash', and 'error' keys
    """
    if not s3_client:
        return {
            "success": False,
            "ipfs_hash": None,
            "error": "Filebase not configured. Please set FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY in .env"
        }
    
    # Create the file path (e.g., "example.eth/.well-known/atproto-did")
    file_path = f"{domain}/.well-known/atproto-did"
    
    # Create file content (just the DID string)
    file_content = did.encode('utf-8')
    
    try:
        # Upload to Filebase (this automatically pins to IPFS)
        put_response = s3_client.put_object(
            Bucket=FILEBASE_BUCKET,
            Key=file_path,
            Body=file_content,
            ContentType='text/plain'
        )
        
        # Get the IPFS hash/CID from the response
        # Filebase returns the CID in the ETag or we need to query it
        # Try to get from response metadata first
        ipfs_hash = None
        
        # Check response metadata
        if 'ResponseMetadata' in put_response:
            headers = put_response['ResponseMetadata'].get('HTTPHeaders', {})
            # Filebase may return CID in various headers
            ipfs_hash = (
                headers.get('x-amz-meta-cid') or
                headers.get('x-ipfs-cid') or
                headers.get('etag', '').strip('"')
            )
        
        # If not in headers, try to get from object metadata after upload
        if not ipfs_hash:
            try:
                head_response = s3_client.head_object(
                    Bucket=FILEBASE_BUCKET,
                    Key=file_path
                )
                # Check metadata
                metadata = head_response.get('Metadata', {})
                ipfs_hash = metadata.get('cid') or metadata.get('ipfs-hash')
                
                # Also check response headers
                if not ipfs_hash and 'ResponseMetadata' in head_response:
                    headers = head_response['ResponseMetadata'].get('HTTPHeaders', {})
                    ipfs_hash = (
                        headers.get('x-amz-meta-cid') or
                        headers.get('x-ipfs-cid')
                    )
            except Exception:
                pass
        
        # If we still don't have the hash, the file is pinned but we can't retrieve the CID
        # This is acceptable - the file is still pinned to IPFS
        if not ipfs_hash:
            ipfs_hash = "pinned"  # Indicates file is pinned but CID not available
        
        return {
            "success": True,
            "ipfs_hash": ipfs_hash,
            "error": None
        }
        
    except ClientError as e:
        return {
            "success": False,
            "ipfs_hash": None,
            "error": f"Failed to pin to Filebase: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "ipfs_hash": None,
            "error": f"Unexpected error pinning to Filebase: {str(e)}"
        }


@app.post("/atproto-did/{domain}")
async def create_atproto_did(domain: str, request: CreateDidRequest) -> JSONResponse:
    """
    Create and pin a .well-known/atproto-did file for an ENS domain.
    
    Args:
        domain: The ENS domain (e.g., "example.eth" or "bot.reality.eth")
        request: Request body with 'did' field
    
    Returns:
        JSON response with success status, IPFS hash, and error information
    """
    # Validate domain format (should end with .eth)
    if not domain.endswith('.eth'):
        raise HTTPException(
            status_code=400,
            detail="Domain must end with .eth"
        )
    
    # Validate request domain matches path parameter
    if request.domain != domain:
        raise HTTPException(
            status_code=400,
            detail="Domain in request body must match path parameter"
        )
    
    # Validate DID format
    if not is_valid_did(request.did):
        return JSONResponse(
            content={
                "success": False,
                "ipfs_hash": None,
                "error": f"Invalid DID format: {request.did}",
                "errorType": "invalid_did"
            },
            status_code=400
        )
    
    # Check if file already exists
    existing_check = await check_existing_did(domain, request.did)
    
    if existing_check["exists"]:
        if existing_check["matches"]:
            return JSONResponse(
                content={
                    "success": False,
                    "ipfs_hash": None,
                    "error": f"File already exists with the same DID: {existing_check['current_did']}",
                    "errorType": "already_exists"
                },
                status_code=200
            )
        else:
            return JSONResponse(
                content={
                    "success": False,
                    "ipfs_hash": None,
                    "error": f"File already exists with different DID: {existing_check['current_did']}",
                    "errorType": "conflict"
                },
                status_code=200
            )
    
    # Pin to Filebase
    pin_result = await pin_to_filebase(domain, request.did)
    
    if pin_result["success"]:
        return JSONResponse(
            content={
                "success": True,
                "ipfs_hash": pin_result["ipfs_hash"],
                "error": None,
                "errorType": None
            },
            status_code=200
        )
    else:
        return JSONResponse(
            content={
                "success": False,
                "ipfs_hash": None,
                "error": pin_result["error"],
                "errorType": "pin_failure"
            },
            status_code=500
        )


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

