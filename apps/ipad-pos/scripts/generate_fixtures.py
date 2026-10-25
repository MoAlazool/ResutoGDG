#!/usr/bin/env python3
"""Synthetic contract fixtures, not staging evidence. No credentials or customer data."""
import json
from pathlib import Path
out=Path(__file__).resolve().parents[1]/'Tests/ResutoCoreTests/Fixtures'
def write(name, value): (out/(name+'.json')).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
p='11111111-1111-4111-8111-111111111111'; b='22222222-2222-4222-8222-222222222222'
write('menu',dict(currency='EGP',menus=[dict(id='menu',branchId=None,isActive=True)],categories=[dict(id='category',menuId='menu',name='Kitchen',nameAr='المطبخ',isActive=True)],modifierGroups=[dict(id='group',name='Size',nameAr='الحجم',isActive=True,minSelect=1,maxSelect=1,options=[dict(id='option',groupId='group',name='Regular',nameAr='عادي',priceDeltaMinor=150,isDefault=True,isAvailable=True)])],products=[dict(id=p,categoryId='category',name='Lunch',nameAr='غداء',description=None,descriptionAr=None,priceMinor=10000,currency='EGP',imageUrl=None,isActive=True,trackStock=True,version=1,branchSettings=[dict(branchId=b,isAvailable=True,priceOverrideMinor=9000,stockQty=5,soldOut=False)],modifierGroupIds=['group'],allergens=['milk'])]))
write('accepted',dict(id='33333333-3333-4333-8333-333333333333',number='42',status='placed',totalMinor=10431,currency='EGP'))
write('me',dict(user=dict(id='user',email=None,fullName=None,locale='en'),memberships=[dict(orgId='org',orgSlug='venue',orgName='Venue',role='cashier',branchIds=[b])],platformRole=None))
write('error',dict(error=dict(code='version_conflict',message='Order changed',requestId='request-42')))
write('orders',dict(items=[dict(id='order',number='42',branchId=b,fulfillment='pickup',status='placed',paymentStatus='unpaid',tableLabel=None,visitId=None,currency='EGP',totalMinor=10431,paidMinor=0,refundedMinor=0,dueMinor=10431,placedAt='2026-10-24T12:00:00Z',version=0)],nextCursor=None))
write('detail',dict(id='order',number='42',branchId=b,fulfillment='pickup',status='placed',paymentStatus='unpaid',currency='EGP',totalMinor=10431,dueMinor=10431,subtotalMinor=9150,discountMinor=0,serviceChargeMinor=0,taxMinor=1281,deliveryFeeMinor=0,taxInclusive=False,version=0,lines=[dict(id='line',name='Lunch',nameAr='غداء',quantity=1,lineTotalMinor=9150,kitchenStatus='queued',notes=None)],payments=[]))
write('floor',dict(branchId=b,revision=1,width=1000,height=800,zones=[],objects=[],background=dict(image=None,opacity=0.45,x=0,y=0,width=1000,height=800),tables=[dict(id='table',label='T1',capacity=4,zone=None,shape='round',cx=200,cy=200,width=90,height=90,rotation=0,status='available',version=0)]))
