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
from typing import Dict, Any, Optional
from dotenv import load_dotenv
from io import BytesIO
import tempfile
import shutil
import content_hash
from web3 import Web3

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

# Sepolia testing mode - use test server instead of .eth.link gateway
TEST_SERVER_URL = os.getenv('TEST_SERVER_URL')  # e.g., "http://localhost:3000"
SEPOLIA_TEST_MODE = os.getenv('SEPOLIA_TEST_MODE', 'false').lower() == 'true'

# Ethereum RPC configuration for ENS Registry queries
ETH_RPC_URL = os.getenv('ETH_RPC_URL')  # e.g., "https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY" or "https://sepolia.infura.io/v3/YOUR_KEY"
# ENS Registry contract address (same on Mainnet and Sepolia)
ENS_REGISTRY_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
# ENS Registry ABI - need owner() and resolver() functions
ENS_REGISTRY_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "node", "type": "bytes32"}],
        "name": "owner",
        "outputs": [{"name": "", "type": "address"}],
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [{"name": "node", "type": "bytes32"}],
        "name": "resolver",
        "outputs": [{"name": "", "type": "address"}],
        "type": "function"
    }
]
# ENS Resolver ABI - need contenthash() function
ENS_RESOLVER_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "node", "type": "bytes32"}],
        "name": "contenthash",
        "outputs": [{"name": "", "type": "bytes"}],
        "type": "function"
    }
]

# Initialize Web3 if RPC URL is provided
web3_instance = None
ens_registry_contract = None
if ETH_RPC_URL:
    try:
        web3_instance = Web3(Web3.HTTPProvider(ETH_RPC_URL))
        if web3_instance.is_connected():
            ens_registry_contract = web3_instance.eth.contract(
                address=Web3.to_checksum_address(ENS_REGISTRY_ADDRESS),
                abi=ENS_REGISTRY_ABI
            )
        else:
            print(f"Warning: Failed to connect to Ethereum RPC at {ETH_RPC_URL}")
            web3_instance = None
    except Exception as e:
        print(f"Warning: Failed to initialize Web3: {e}")
        web3_instance = None
        ens_registry_contract = None

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


def encode_ipfs_to_contenthash(ipfs_cid: str) -> str:
    """
    Encode an IPFS CID to ENS contenthash format using the content-hash library.
    
    Args:
        ipfs_cid: The IPFS CID string (e.g., "Qm..." or "bafy...")
    
    Returns:
        Hex string of the contenthash (e.g., "0xe301...")
    """
    # Use content-hash library to encode
    codec = 'ipfs'
    value = content_hash.encode(codec, ipfs_cid)
    
    # content_hash.encode returns bytes, convert to hex string with 0x prefix
    return '0x' + value


def ens_namehash(name: str) -> bytes:
    """
    Calculate the namehash for an ENS domain name.
    
    Args:
        name: The ENS domain (e.g., "example.eth")
    
    Returns:
        bytes32 namehash
    """
    if not name:
        return b'\x00' * 32
    
    # Split the name into labels
    labels = name.split('.')
    
    # Start with the zero hash
    node = b'\x00' * 32
    
    # Process labels in reverse order (right to left)
    for label in reversed(labels):
        # Hash the label
        label_hash = Web3.keccak(text=label)
        # Hash the concatenation of the previous node and label hash
        # Convert both to hex strings, remove 0x prefix, concatenate, then hash
        node_hex = Web3.to_hex(node)[2:]  # Remove '0x'
        label_hex = Web3.to_hex(label_hash)[2:]  # Remove '0x'
        combined = '0x' + node_hex + label_hex
        node = Web3.keccak(hexstr=combined)
    
    return node


def check_ens_domain_registered(domain: str) -> Optional[bool]:
    """
    Check if an ENS domain is registered by querying the ENS Registry contract.
    
    Args:
        domain: The ENS domain (e.g., "example.eth")
    
    Returns:
        True if registered, False if not registered, None if check failed/unavailable
    """
    if not ens_registry_contract or not web3_instance:
        # RPC not configured or not available
        return None
    
    try:
        # Calculate namehash for the domain
        node = ens_namehash(domain)
        
        # Call the owner() function on the registry contract
        owner = ens_registry_contract.functions.owner(node).call()
        
        # If owner is zero address, domain is not registered
        # Otherwise, it's registered (even if resolver/contenthash not set)
        zero_address = '0x0000000000000000000000000000000000000000'
        is_registered = owner.lower() != zero_address.lower()
        return is_registered
    except Exception as e:
        # If there's an error, return None to indicate we couldn't check
        print(f"Error checking ENS domain registration for {domain}: {e}")
        return None


def check_ens_contenthash_exists(domain: str) -> Optional[bool]:
    """
    Check if an ENS domain has a contenthash set by querying the resolver contract.
    
    Args:
        domain: The ENS domain (e.g., "example.eth")
    
    Returns:
        True if contenthash exists, False if not set, None if check failed/unavailable
    """
    if not ens_registry_contract or not web3_instance:
        # RPC not configured or not available
        return None
    
    try:
        # Calculate namehash for the domain
        node = ens_namehash(domain)
        
        # Get the resolver address from the registry
        resolver_address = ens_registry_contract.functions.resolver(node).call()
        
        zero_address = '0x0000000000000000000000000000000000000000'
        if resolver_address.lower() == zero_address.lower():
            # No resolver set, so no contenthash
            return False
        
        # Create resolver contract instance
        resolver_contract = web3_instance.eth.contract(
            address=Web3.to_checksum_address(resolver_address),
            abi=ENS_RESOLVER_ABI
        )
        
        # Query the contenthash
        contenthash_bytes = resolver_contract.functions.contenthash(node).call()
        
        # If contenthash is empty (0x or empty bytes), it's not set
        if not contenthash_bytes or contenthash_bytes == b'' or contenthash_bytes.hex() == '00':
            return False
        
        # Contenthash exists
        return True
    except Exception as e:
        # If there's an error (e.g., resolver doesn't support contenthash), return None
        print(f"Error checking ENS contenthash for {domain}: {e}")
        return None


async def query_eth_link_gateway(domain: str) -> Dict[str, Any]:
    """
    Query the .eth.link gateway (or test server in Sepolia mode) for the .well-known/atproto-did file.
    
    Args:
        domain: The ENS domain (e.g., "example.eth" or "bot.reality.eth")
    
    Returns:
        Dict with 'success', 'did', 'error', and 'errorType' keys
    """
    # First, check if the domain is registered via ENS Registry (if available)
    registration_status = check_ens_domain_registered(domain)
    # Also check if contenthash exists
    contenthash_exists = check_ens_contenthash_exists(domain)
    
    # Use test server if Sepolia test mode is enabled
    if SEPOLIA_TEST_MODE and TEST_SERVER_URL:
        gateway_url = f"{TEST_SERVER_URL}/.well-known/atproto-did?ens={domain}"
    else:
        # Construct the gateway URL
        gateway_url = f"https://{domain}.link/.well-known/atproto-did/"
    
    try:
        # Make request with 10-second timeout
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(gateway_url)
            
            # Check if the domain exists (404 means gateway couldn't find it)
            if response.status_code == 404:
                # If we know the domain is registered and has a contenthash, but gateway returns 404,
                # it means the contenthash points to content that doesn't have the .well-known/atproto-did file
                if registration_status is True and contenthash_exists is True:
                    return {
                        "success": False,
                        "did": None,
                        "error": f"ENS domain '{domain}' is registered and has a contenthash set, but the content does not include a .well-known/atproto-did file. Please update the contenthash to point to content that includes this file.",
                        "errorType": "no_did_file"
                    }
                # If domain is registered but no contenthash is set
                elif registration_status is True and contenthash_exists is False:
                    return {
                        "success": False,
                        "did": None,
                        "error": f"ENS domain '{domain}' is registered but does not have a contenthash set. Please set the contenthash for this domain.",
                        "errorType": "no_contenthash"
                    }
                # If we know it's not registered, return that
                elif registration_status is False:
                    return {
                        "success": False,
                        "did": None,
                        "error": f"ENS domain '{domain}' is not registered",
                        "errorType": "no_domain"
                    }
                # If we couldn't check registration, use the old behavior (assume not registered)
                else:
                    return {
                        "success": False,
                        "did": None,
                        "error": f"ENS domain '{domain}' is not registered or does not have a .well-known/atproto-did file",
                        "errorType": "no_domain"
                    }
            
            # Check for other HTTP errors
            if not response.is_success:
                # If we know the domain is registered and has contenthash, provide more context
                if registration_status is True and contenthash_exists is True:
                    return {
                        "success": False,
                        "did": None,
                        "error": f"ENS domain '{domain}' is registered and has a contenthash set, but gateway returned status {response.status_code}. The content may not include a .well-known/atproto-did file.",
                        "errorType": "gateway_failure"
                    }
                # If domain is registered but no contenthash
                elif registration_status is True and contenthash_exists is False:
                    return {
                        "success": False,
                        "did": None,
                        "error": f"ENS domain '{domain}' is registered but gateway returned status {response.status_code}. The domain may not have a contenthash set.",
                        "errorType": "gateway_failure"
                    }
                else:
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
    Create and pin a .well-known/atproto-did file to local IPFS and Filebase.
    Pins locally first to get the hash, then also pins to Filebase for redundancy.
    Only errors if both local and Filebase pinning fail.
    
    Args:
        domain: The ENS domain
        did: The DID to store
    
    Returns:
        Dict with 'success', 'ipfs_hash', and 'error' keys
    """
    # Create file content (just the DID string)
    file_content = did.encode('utf-8')
    
    # Step 1: Pin to local IPFS first and get the directory hash
    directory_hash = None
    local_ipfs_error = None
    filebase_error = None
    
    try:
        # Create a temporary directory structure
        with tempfile.TemporaryDirectory() as temp_dir:
            # Create the domain directory
            domain_dir = os.path.join(temp_dir, domain)
            os.makedirs(domain_dir, exist_ok=True)
            
            # Create the .well-known directory
            well_known_dir = os.path.join(domain_dir, '.well-known')
            os.makedirs(well_known_dir, exist_ok=True)
            
            # Write the DID file
            did_file = os.path.join(well_known_dir, 'atproto-did')
            with open(did_file, 'wb') as f:
                f.write(file_content)
                f.flush()
                os.fsync(f.fileno())  # Ensure file is written to disk
            
            # Verify the file exists and has content before adding to IPFS
            # Also verify the directory structure is correct
            if not os.path.exists(did_file):
                local_ipfs_error = f"File was not created: {did_file}"
            elif os.path.getsize(did_file) == 0:
                local_ipfs_error = f"File is empty: {did_file}"
            elif os.path.getsize(did_file) != len(file_content):
                local_ipfs_error = f"File size mismatch: expected {len(file_content)}, got {os.path.getsize(did_file)}"
            elif not os.path.exists(well_known_dir):
                local_ipfs_error = f".well-known directory does not exist: {well_known_dir}"
            elif 'atproto-did' not in os.listdir(well_known_dir):
                local_ipfs_error = f"File not found in .well-known directory. Contents: {os.listdir(well_known_dir)}"
            else:
                # Pin to local IPFS and get the directory hash using subprocess
                # Use -H flag to include hidden directories (dotfiles)
                try:
                    import subprocess
                    result = subprocess.run(
                        ['ipfs', 'add', '-r', '-H', '-Q', domain_dir],
                        capture_output=True,
                        text=True,
                        timeout=10
                    )
                    if result.returncode == 0:
                        directory_hash = result.stdout.strip()
                        # Verify we got a valid hash and it's not the empty directory hash
                        if directory_hash == 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn':
                            # This is the empty directory hash - the file wasn't included properly
                            local_ipfs_error = f"IPFS returned empty directory hash. Check directory: {domain_dir}"
                            directory_hash = None
                    else:
                        local_ipfs_error = f"ipfs command failed: {result.stderr}"
                except FileNotFoundError:
                    local_ipfs_error = "ipfs command not found. Please install IPFS from https://ipfs.io"
                except Exception as e:
                    local_ipfs_error = f"Subprocess IPFS error: {str(e)}"
    
    except Exception as e:
        local_ipfs_error = f"Local IPFS pinning error: {str(e)}"
    
    # Step 2: Also pin to Filebase (but don't fail if this fails)
    if s3_client:
        try:
            # Create the file path (e.g., "example.eth/.well-known/atproto-did")
            file_path = f"{domain}/.well-known/atproto-did"
            
            # Upload to Filebase (this automatically pins to IPFS)
            s3_client.put_object(
                Bucket=FILEBASE_BUCKET,
                Key=file_path,
                Body=file_content,
                ContentType='text/plain'
            )
        except Exception as e:
            filebase_error = f"Filebase pinning error: {str(e)}"
    else:
        filebase_error = "Filebase not configured. Please set FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY in .env"
    
    # Step 3: Return result - only error if both failed
    if directory_hash:
        # Success - we got the hash from local IPFS
        return {
            "success": True,
            "ipfs_hash": directory_hash,
            "error": None if not filebase_error else f"Local IPFS pinning succeeded, but Filebase pinning failed: {filebase_error}"
        }
    else:
        # Both failed
        errors = []
        if local_ipfs_error:
            errors.append(f"Local IPFS: {local_ipfs_error}")
        if filebase_error:
            errors.append(f"Filebase: {filebase_error}")
        
        return {
            "success": False,
            "ipfs_hash": None,
            "error": f"Both pinning methods failed. {'; '.join(errors)}"
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
    
    # Pin to local IPFS and Filebase
    pin_result = await pin_to_filebase(domain, request.did)
    
    if pin_result["success"]:
        # Encode IPFS hash to contenthash format
        try:
            contenthash = encode_ipfs_to_contenthash(pin_result["ipfs_hash"])
        except Exception as e:
            return JSONResponse(
                content={
                    "success": False,
                    "ipfs_hash": pin_result["ipfs_hash"],
                    "contenthash": None,
                    "error": f"Failed to encode contenthash: {str(e)}",
                    "errorType": "encoding_error"
                },
                status_code=500
            )
        
        return JSONResponse(
            content={
                "success": True,
                "ipfs_hash": pin_result["ipfs_hash"],
                "contenthash": contenthash,
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
