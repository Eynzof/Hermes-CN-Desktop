"""Write portable ZIP paths so Windows evidence also opens on macOS/Linux."""
import sys
import zipfile
from pathlib import Path

source, destination = map(Path, sys.argv[1:3])
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(source.rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(source).as_posix())
