#!/usr/bin/env python3
"""Pinned draft review, separate from the existing staff OpenAPI checks. No live API claim."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[3]
native = root / 'apps/ipad-pos'
review = json.loads((native / 'contracts/pos-api-draft.json').read_text())
required = {
    '/v1/pos/pair': 'post', '/v1/pos/session': 'get', '/v1/pos/events': 'get',
    '/v1/pos/sync/menu': 'get', '/v1/pos/sync/floor': 'get', '/v1/pos/sync/orders': 'get',
    '/v1/pos/orders/quote': 'post', '/v1/pos/orders': 'post',
}
for path, method in required.items():
    assert method in review['operations'].get(path, []), (method, path)
assert review['sourceContractVersion'] == '0.1.0'
assert review['staffOnDeviceVersion'] == '0.2.0_proposed_not_merged'
assert review['proposedOperations']['/v1/pos/orders/by-client-id/{clientOrderId}'] == ['get']
client = (native / 'Sources/ResutoCore/POSClient.swift').read_text()
assert 'X-Resuto-Staff-Authorization' in client
assert 'method == "GET"' in client and 'device_revoked' in client
assert 'pair.contractVersion == "0.2.0"' in client
# Once the shared branch lands in this base, check matching routes against it too; never edit shared OpenAPI here.
base_paths = json.loads((root / 'docs/api/openapi.json').read_text())['paths']
for path, method in required.items():
    if path in base_paths:
        assert method in base_paths[path], ('Shared API drift', method, path)
print(f'DRAFT REVIEW: {len(required)} adapter operations match pinned Claude {review["sourceRevision"][:7]} API 0.1.0')
print('PENDING: 0.2.0 staff-on-device/reconciliation implementation, deployment and native staging acceptance')
