#!/usr/bin/env python3
"""Static route/permission drift checks. Does not substitute for an authenticated staging lifecycle."""
import json, re, sys, plistlib
from pathlib import Path
root=Path(__file__).resolve().parents[3]
paths=json.loads((root/'docs/api/openapi.json').read_text())['paths']
required={
'/v1/o/{orgId}/customers':['get'], '/v1/o/{orgId}/reservations':['get'], '/v1/o/{orgId}/reservations/{id}/check-in':['post'], '/v1/o/{orgId}/kitchen/lines/{lineId}':['post'], '/v1/me':['get'], '/v1/o/{orgId}':['get'], '/v1/o/{orgId}/menu':['get'],
'/v1/o/{orgId}/floor/{branchId}':['get'], '/v1/o/{orgId}/floor/{branchId}/live':['get'],
'/v1/o/{orgId}/orders':['get','post'], '/v1/o/{orgId}/orders/{id}':['get'],
'/v1/o/{orgId}/orders/{id}/transition':['post'], '/v1/o/{orgId}/orders/{id}/cancel':['post'],
'/v1/o/{orgId}/orders/{id}/collect':['post'], '/v1/o/{orgId}/kitchen/{branchId}':['get'],
'/v1/o/{orgId}/visits':['post'], '/v1/o/{orgId}/visits/{visitId}/close':['post'],
'/v1/o/{orgId}/tables/{tableId}/clean':['post'], '/v1/o/{orgId}/payments/{paymentId}/refunds':['post']}
for path, methods in required.items():
    for method in methods:
        assert method in paths.get(path,{}), f'Missing contract: {method} {path}'
# Native implementation never submits an unsupported pos channel or invents a quote URL.
swift='\n'.join(p.read_text() for p in (root/'apps/ipad-pos/Sources').rglob('*.swift'))
assert 'self.channel = "staff"' in swift
assert '6 * 24 * 3600' in swift, 'Retry horizon must remain below 7-day server retention'
for name in ['Info.plist','PrivacyInfo.xcprivacy']:
    plistlib.loads((root/'apps/ipad-pos/Resources'/name).read_bytes())
print(f'PASS: {sum(map(len,required.values()))} route/method contracts, request channel, retention, resource plists')

localization=(root/'apps/ipad-pos/App/Localization.swift').read_text()
en,ar=localization.split('static let en:')[1].split('static let ar:')
key_pattern=r'"([^"\n]+)"\s*:'
assert set(re.findall(key_pattern,en)) == set(re.findall(key_pattern,ar)), 'English/Arabic localization keys differ'
print('PASS: English/Arabic localization key parity')
