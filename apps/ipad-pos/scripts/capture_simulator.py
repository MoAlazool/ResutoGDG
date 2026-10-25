#!/usr/bin/env python3
"""Capture real CoreSimulator frames requested by the UI-test runner. No app/backend writes."""
import argparse, json, subprocess, time, re
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--device',required=True)
parser.add_argument('--output',required=True)
parser.add_argument('--label',default='review')
args=parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_-]{1,32}',args.label):parser.error('Capture label must use 1–32 letters, digits, underscores or hyphens')
output=Path(args.output)/args.label;output.mkdir(parents=True,exist_ok=True)
container=None
seen=set()
while True:
    if container is None:
        found=subprocess.run(['xcrun','simctl','get_app_container',args.device,'com.resuto.ipadpos.uitests.xctrunner','data'],capture_output=True,text=True)
        if found.returncode==0:container=Path(found.stdout.strip())/'Documents'
    if container is not None:
        request=container/'resuto-visual-request.json'
        try:
            value=json.loads(request.read_text());seq=value['sequence'];name=value['name']
            if seq not in seen:
                assert name and len(name)<100 and all(c.isascii() and (c.isalnum() or c in '-_') for c in name)
                target=output/(name+'.png')
                result=subprocess.run(['xcrun','simctl','io',args.device,'screenshot','--type=png',str(target)],capture_output=True,text=True)
                if result.returncode:raise RuntimeError(result.stderr.strip())
                seen.add(seq)
                ack=container/'resuto-visual-ack.json';tmp=ack.with_suffix('.tmp')
                tmp.write_text(json.dumps({'sequence':seq,'file':target.name}));tmp.replace(ack)
                print('Captured '+target.name,flush=True)
        except (FileNotFoundError,json.JSONDecodeError,KeyError):pass
    time.sleep(0.25)
