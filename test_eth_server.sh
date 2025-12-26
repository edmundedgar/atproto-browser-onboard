#!/bin/bash

# Test script for ETH Domain ATProto DID Server
# Usage: ./test_eth_server.sh [base_url]
# Default: http://127.0.0.1:8000

BASE_URL="${1:-http://127.0.0.1:8000}"
DOMAIN="edmundedgar.eth"
EXAMPLE_DID="did:plc:abc123def456ghi789jkl012mno345pqr678stu901vwx234"

echo "Testing ETH Domain ATProto DID Server at $BASE_URL"
echo "=================================================="
echo ""

# Test 1: Health check
echo "1. Testing health check endpoint..."
curl -s "$BASE_URL/health" | jq '.'
echo ""
echo ""

# Test 2: GET endpoint - check if DID exists
echo "2. Testing GET endpoint for $DOMAIN..."
echo "GET $BASE_URL/atproto-did/$DOMAIN"
curl -s "$BASE_URL/atproto-did/$DOMAIN" | jq '.'
echo ""
echo ""

# Test 3: POST endpoint - create/pin DID file
echo "3. Testing POST endpoint to create/pin DID for $DOMAIN..."
echo "POST $BASE_URL/atproto-did/$DOMAIN"
echo "Body: {\"domain\": \"$DOMAIN\", \"did\": \"$EXAMPLE_DID\"}"
curl -s -X POST "$BASE_URL/atproto-did/$DOMAIN" \
  -H "Content-Type: application/json" \
  -d "{\"domain\": \"$DOMAIN\", \"did\": \"$EXAMPLE_DID\"}" | jq '.'
echo ""
echo ""

# Test 4: GET endpoint again - verify it was created
echo "4. Testing GET endpoint again to verify DID was created..."
echo "GET $BASE_URL/atproto-did/$DOMAIN"
curl -s "$BASE_URL/atproto-did/$DOMAIN" | jq '.'
echo ""
echo ""

# Test 5: POST endpoint again - should return error (already exists)
echo "5. Testing POST endpoint again (should fail - already exists)..."
echo "POST $BASE_URL/atproto-did/$DOMAIN"
curl -s -X POST "$BASE_URL/atproto-did/$DOMAIN" \
  -H "Content-Type: application/json" \
  -d "{\"domain\": \"$DOMAIN\", \"did\": \"$EXAMPLE_DID\"}" | jq '.'
echo ""
echo ""

echo "Tests completed!"

