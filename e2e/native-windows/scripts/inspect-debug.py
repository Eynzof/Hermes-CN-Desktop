"""Read a UI-created debug bundle without emitting configuration or log secrets."""
import json, sys, zipfile
from pathlib import Path
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    key = next(line.split('=', 1)[1].strip() for line in Path(sys.argv[2]).read_text().splitlines() if line.startswith('DEEPSEEK_API_KEY='))
    manifest = json.loads(archive.read('diagnostics/manifest.json'))
    renderer = json.loads(archive.read('diagnostics/renderer.json'))
    events = json.loads(archive.read('diagnostics/frontend-debug-bus.json'))
    leaked = [name for name in names if not name.endswith('/') and key.encode() in archive.read(name)]
    print(json.dumps({'names': names, 'badCrc': archive.testzip(), 'manifest': manifest, 'build': renderer['build'], 'eventCount': len(events), 'secretFiles': leaked}, ensure_ascii=False))
