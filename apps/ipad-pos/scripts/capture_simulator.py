#!/usr/bin/env python3
"""Capture CoreSimulator pixels; retain originals and normalize orientation only for review."""
import argparse,json,subprocess,time,re,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--device',required=True);p.add_argument('--output',required=True);p.add_argument('--label',default='review');a=p.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_-]{1,32}',a.label):p.error('Invalid capture label')
output=Path(a.output)/a.label;raw=output/'raw';raw.mkdir(parents=True,exist_ok=True)
seen=set();container=None;last_lookup=0
while True:
    if time.monotonic()-last_lookup>2:
        last_lookup=time.monotonic()
        r=subprocess.run(['xcrun','simctl','get_app_container',a.device,'com.resuto.ipadpos.uitests.xctrunner','data'],capture_output=True,text=True)
        if r.returncode==0:container=Path(r.stdout.strip())/'Documents'/'ResutoVisualRequests'
    if container is not None:
        for request in sorted(container.glob('*.json')):
            if request.name.endswith('.ack.json'):continue
            try:
                value=json.loads(request.read_text());seq=value['sequence'];name=value['name']
                if seq in seen:continue
                assert re.fullmatch(r'[A-Za-z0-9_-]{1,99}',name)
                print('Capturing '+name,flush=True);started=time.monotonic()
                original=raw/(name+'.png');target=output/(name+'.png')
                subprocess.run(['xcrun','simctl','io',a.device,'screenshot','--type=png',str(original)],check=True,capture_output=True)
                info=subprocess.check_output(['sips','-g','pixelWidth','-g','pixelHeight',str(original)],text=True)
                width=int(re.search(r'pixelWidth: (\d+)',info)[1]);height=int(re.search(r'pixelHeight: (\d+)',info)[1])
                rotation=-90 if value.get('landscape') and height>width else 0
                if rotation:subprocess.run(['sips','-r',str(rotation),str(original),'--out',str(target)],check=True,capture_output=True)
                else:shutil.copyfile(original,target)
                (output/(name+'.json')).write_text(json.dumps({'source':'CoreSimulator screen capture','raw':str(Path('raw')/original.name),'rotationDegrees':rotation,'requestedAt':value.get('requestedAt'),'captureDurationSeconds':round(time.monotonic()-started,3)},indent=2)+'\n')
                ack=request.with_suffix('.ack.json');tmp=ack.with_suffix('.tmp');tmp.write_text(json.dumps({'sequence':seq,'file':target.name}));tmp.replace(ack);seen.add(seq)
                print('Captured '+name,flush=True)
            except (FileNotFoundError,json.JSONDecodeError,KeyError):pass
    time.sleep(.25)
