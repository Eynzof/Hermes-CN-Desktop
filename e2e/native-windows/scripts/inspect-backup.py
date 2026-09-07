import hashlib
import json
from pathlib import Path
import sys
import zipfile

archive = Path(sys.argv[1])
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None, 'ZIP CRC mismatch'
    manifest = json.loads(z.read('manifest.json'))
    assert manifest['kind'] == 'hermes-profile-backup'
    assert 'profile/config.yaml' in z.namelist()
    assert 'profile/.env' in z.namelist()
    print(json.dumps({'kind': manifest['kind'], 'entries': len(z.namelist()),
                      'hasStateDb': 'profile/state.db' in z.namelist(),
                      'sessionFiles': [name for name in z.namelist() if name.startswith('profile/sessions/') and not name.endswith('/')],
                      'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))
