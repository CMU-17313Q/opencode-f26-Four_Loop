#!/usr/bin/env python3
"""Install one official k6 release locally; never use sudo or alter a global install."""
from pathlib import Path
import hashlib, io, json, os, platform, re, subprocess, tarfile, urllib.request, zipfile
BASE = Path(__file__).resolve().parent
VERSION = (BASE / 'version.txt').read_text().strip()
if not re.fullmatch(r'\d+\.\d+\.\d+', VERSION): raise SystemExit('Invalid pinned version')
SYSTEM = {'Linux': ['linux'], 'Darwin': ['macos', 'darwin']}.get(platform.system())
ARCH = {'x86_64': 'amd64', 'AMD64': 'amd64', 'arm64': 'arm64', 'aarch64': 'arm64'}.get(platform.machine())
if not SYSTEM or not ARCH: raise SystemExit('Use macOS/Linux; on Windows use WSL or a Linux devcontainer')
DEST = BASE / 'bin/k6'
if DEST.exists():
    output = subprocess.run([str(DEST),'version'],capture_output=True,text=True,check=True).stdout
    if re.search(r'\bv'+re.escape(VERSION)+r'\b',output):
        print(output.strip());raise SystemExit(0)
    raise SystemExit('Existing local k6 has a different version; remove ci/load/bin/k6 before reinstalling')
def download(url):
    if not url.startswith('https://'): raise RuntimeError('Only HTTPS downloads are allowed')
    request=urllib.request.Request(url,headers={'User-Agent':'The-Boys-P3-k6-installer','Accept':'application/vnd.github+json'})
    with urllib.request.urlopen(request,timeout=90) as response:
        result=response.read(150*1024*1024+1)
    if len(result)>150*1024*1024:raise RuntimeError('Download unexpectedly large')
    return result
release=json.loads(download(f'https://api.github.com/repos/grafana/k6/releases/tags/v{VERSION}'))
assets=release.get('assets',[])
matching=[a for a in assets if any(f'{s}-{ARCH}' in a['name'] for s in SYSTEM) and a['name'].endswith(('.tar.gz','.zip'))]
if len(matching)!=1:raise SystemExit('Could not uniquely locate the official archive for this platform; inspect the release assets')
asset=matching[0]
expected=None
if str(asset.get('digest','')).startswith('sha256:'):expected=asset['digest'].split(':',1)[1]
checksum_files=[a for a in assets if 'checksum' in a['name'].lower() and not a['name'].endswith(('.sig','.asc'))]
for checks in checksum_files:
    for line in download(checks['browser_download_url']).decode().splitlines():
        parts=line.strip().split()
        if len(parts)>=2 and parts[-1].lstrip('*')==asset['name'] and re.fullmatch('[0-9a-fA-F]{64}',parts[0]):
            if expected and expected.lower()!=parts[0].lower():raise RuntimeError('Conflicting release checksums')
            expected=parts[0].lower()
if not expected:raise SystemExit('No SHA256 digest found; refusing an unverified binary download')
archive=download(asset['browser_download_url'])
actual=hashlib.sha256(archive).hexdigest()
if actual!=expected.lower():raise SystemExit('k6 checksum mismatch')
if asset['name'].endswith('.zip'):
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        names=[n for n in z.namelist() if Path(n).name=='k6' and not n.endswith('/')]
        if len(names)!=1:raise RuntimeError('Unexpected archive layout')
        binary=z.read(names[0])
else:
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as t:
        entries=[m for m in t.getmembers() if m.isfile() and Path(m.name).name=='k6']
        if len(entries)!=1:raise RuntimeError('Unexpected archive layout')
        binary=t.extractfile(entries[0]).read()
DEST.parent.mkdir(parents=True,exist_ok=True)
DEST.write_bytes(binary);DEST.chmod(0o755)
(DEST.parent/'download.json').write_text(json.dumps({'version':VERSION,'url':asset['browser_download_url'],'sha256':actual},indent=2)+'\n')
print('Installed official k6 release with verified SHA256:',VERSION)
