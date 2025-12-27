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
FILEBASE_IPFS_RPC = os.getenv('FILEBASE_IPFS_RPC', 'https://ipfs.filebase.io')
FILEBASE_IPFS_RPC_KEY = os.getenv('FILEBASE_IPFS_RPC_KEY')  # Optional IPFS RPC API key

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
        file_cid = None
        directory_cid = None
        
        # Check response metadata for file CID
        if 'ResponseMetadata' in put_response:
            headers = put_response['ResponseMetadata'].get('HTTPHeaders', {})
            # Filebase may return CID in various headers
            file_cid = (
                headers.get('x-amz-meta-cid') or
                headers.get('x-ipfs-cid') or
                headers.get('etag', '').strip('"')
            )
            # Also check for directory CID (if Filebase provides it)
            directory_cid = (
                headers.get('x-amz-meta-dir-cid') or
                headers.get('x-ipfs-dir-cid')
            )
        
        # If not in headers, try to get from object metadata after upload
        if not file_cid or not directory_cid:
            try:
                head_response = s3_client.head_object(
                    Bucket=FILEBASE_BUCKET,
                    Key=file_path
                )
                # Check metadata
                metadata = head_response.get('Metadata', {})
                if not file_cid:
                    file_cid = metadata.get('cid') or metadata.get('ipfs-hash')
                if not directory_cid:
                    directory_cid = metadata.get('dir-cid') or metadata.get('ipfs-dir-hash')
                
                # Also check response headers
                if 'ResponseMetadata' in head_response:
                    headers = head_response['ResponseMetadata'].get('HTTPHeaders', {})
                    if not file_cid:
                        file_cid = (
                            headers.get('x-amz-meta-cid') or
                            headers.get('x-ipfs-cid')
                        )
                    if not directory_cid:
                        directory_cid = (
                            headers.get('x-amz-meta-dir-cid') or
                            headers.get('x-ipfs-dir-cid')
                        )
            except Exception:
                pass
        
        # Get the IPFS hash of the parent directory (domain directory)
        # This is what's needed for ENS content hash
        # The directory path is just the domain (e.g., "example.eth/")
        directory_path = f"{domain}/"
        
        # If we already got the directory CID from S3 response, use it
        directory_hash = directory_cid
        
        # Wait a moment for the file to propagate in IPFS
        import asyncio
        await asyncio.sleep(2)
        
        # Try to get the directory hash using IPFS RPC API if we don't have it yet
        error_messages = []
        
        if not directory_hash:
            try:
                if FILEBASE_IPFS_RPC_KEY:
                    headers = {'Authorization': f'Bearer {FILEBASE_IPFS_RPC_KEY}'}
                else:
                    headers = {}
                
                async with httpx.AsyncClient(timeout=10.0) as client:
                    # Method 1: Use IPFS RPC API files/stat with path
                    try:
                        rpc_url = f"{FILEBASE_IPFS_RPC}/api/v0/files/stat"
                        # Try different path formats
                        for path_format in [f"/{directory_path}", directory_path, f"{FILEBASE_BUCKET}/{directory_path}"]:
                            try:
                                params = {'arg': path_format}
                                rpc_response = await client.post(rpc_url, headers=headers, params=params, timeout=10.0)
                                
                                if rpc_response.is_success:
                                    rpc_data = rpc_response.json()
                                    directory_hash = rpc_data.get('Hash')
                                    if directory_hash:
                                        break
                            except Exception:
                                continue
                    except Exception as e2:
                        error_messages.append(f"files/stat method: {str(e2)}")
                    
                    # Method 2: Use IPFS RPC API ls
                    if not directory_hash:
                        try:
                            rpc_url = f"{FILEBASE_IPFS_RPC}/api/v0/ls"
                            for path_format in [f"/{directory_path}", directory_path, f"{FILEBASE_BUCKET}/{directory_path}"]:
                                try:
                                    params = {'arg': path_format}
                                    rpc_response = await client.post(rpc_url, headers=headers, params=params, timeout=10.0)
                                    
                                    if rpc_response.is_success:
                                        rpc_data = rpc_response.json()
                                        if 'Objects' in rpc_data and len(rpc_data['Objects']) > 0:
                                            directory_hash = rpc_data['Objects'][0].get('Hash')
                                            if directory_hash:
                                                break
                                except Exception:
                                    continue
                        except Exception as e3:
                            error_messages.append(f"ls method: {str(e3)}")
                    
                    # Method 3: Use IPFS RPC API object/stat (for IPFS objects, not MFS)
                    if not directory_hash:
                        try:
                            rpc_url = f"{FILEBASE_IPFS_RPC}/api/v0/object/stat"
                            for path_format in [f"/{directory_path}", directory_path, f"{FILEBASE_BUCKET}/{directory_path}"]:
                                try:
                                    params = {'arg': path_format}
                                    rpc_response = await client.post(rpc_url, headers=headers, params=params, timeout=10.0)
                                    
                                    if rpc_response.is_success:
                                        rpc_data = rpc_response.json()
                                        directory_hash = rpc_data.get('Hash')
                                        if directory_hash:
                                            break
                                except Exception:
                                    continue
                        except Exception as e4:
                            error_messages.append(f"object/stat method: {str(e4)}")
                    
                    # Method 4: Try using S3 list_objects to see if we can get directory info
                    if not directory_hash:
                        try:
                            # List objects in the directory to see if Filebase provides directory metadata
                            list_response = s3_client.list_objects_v2(
                                Bucket=FILEBASE_BUCKET,
                                Prefix=directory_path,
                                Delimiter='/',
                                MaxKeys=1
                            )
                            # Check if there's any directory metadata in the response
                            # Filebase might include directory CID in common prefixes or metadata
                            if 'CommonPrefixes' in list_response:
                                # This indicates the directory exists, but doesn't give us the CID
                                pass
                        except Exception as e5:
                            error_messages.append(f"S3 list method: {str(e5)}")
                                    
            except Exception as e:
                error_messages.append(f"General error: {str(e)}")
                
                # Method 2: Use IPFS RPC API files/stat with path
                if not directory_hash:
                    try:
                        rpc_url = f"{FILEBASE_IPFS_RPC}/api/v0/files/stat"
                        # Try different path formats
                        for path_format in [f"/{directory_path}", directory_path, f"{FILEBASE_BUCKET}/{directory_path}"]:
                            try:
                                params = {'arg': path_format}
                                rpc_response = await client.post(rpc_url, headers=headers, params=params, timeout=10.0)
                                
                                if rpc_response.is_success:
                                    rpc_data = rpc_response.json()
                                    directory_hash = rpc_data.get('Hash')
                                    if directory_hash:
                                        break
                            except Exception:
                                continue
                    except Exception as e2:
                        error_messages.append(f"files/stat method: {str(e2)}")
                
                # Method 3: Use IPFS RPC API ls
                if not directory_hash:
                    try:
                        rpc_url = f"{FILEBASE_IPFS_RPC}/api/v0/ls"
                        for path_format in [f"/{directory_path}", directory_path, f"{FILEBASE_BUCKET}/{directory_path}"]:
                            try:
                                params = {'arg': path_format}
                                rpc_response = await client.post(rpc_url, headers=headers, params=params, timeout=10.0)
                                
                                if rpc_response.is_success:
                                    rpc_data = rpc_response.json()
                                    if 'Objects' in rpc_data and len(rpc_data['Objects']) > 0:
                                        directory_hash = rpc_data['Objects'][0].get('Hash')
                                        if directory_hash:
                                            break
                            except Exception:
                                continue
                    except Exception as e3:
                        error_messages.append(f"ls method: {str(e3)}")
                
                # Method 4: Use IPFS RPC API object/stat (for IPFS objects, not MFS)
                if not directory_hash:
                    try:
                        rpc_url = f"{FILEBASE_IPFS_RPC}/api/v0/object/stat"
                        for path_format in [f"/{directory_path}", directory_path, f"{FILEBASE_BUCKET}/{directory_path}"]:
                            try:
                                params = {'arg': path_format}
                                rpc_response = await client.post(rpc_url, headers=headers, params=params, timeout=10.0)
                                
                                if rpc_response.is_success:
                                    rpc_data = rpc_response.json()
                                    directory_hash = rpc_data.get('Hash')
                                    if directory_hash:
                                        break
                            except Exception:
                                continue
                    except Exception as e4:
                        error_messages.append(f"object/stat method: {str(e4)}")
                
                # Method 5: If we have the file CID, try to use it with object/links to find parent
                # This is more complex - we'd need to find which directory contains this file
                # For now, skip this as it requires more complex traversal
                                
        except Exception as e:
            error_messages.append(f"General error: {str(e)}")
        
        # If we couldn't get the directory hash, we need to return an error
        # because the file hash is not what's needed for ENS
        if not directory_hash:
            error_detail = "; ".join(error_messages) if error_messages else "Unknown error"
            return {
                "success": False,
                "ipfs_hash": None,
                "error": f"Could not retrieve directory hash for {directory_path}. File was uploaded but directory CID is required for ENS content hash. Errors: {error_detail}. Please check FILEBASE_IPFS_RPC and FILEBASE_IPFS_RPC_KEY configuration."
            }
        
        return {
            "success": True,
            "ipfs_hash": directory_hash,
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

