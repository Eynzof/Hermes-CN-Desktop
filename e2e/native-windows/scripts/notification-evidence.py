"""Read only Hermes receipts from Windows' actual notification database."""
import json
import os
import sqlite3
from pathlib import Path

database = Path(os.environ['LOCALAPPDATA']) / 'Microsoft/Windows/Notifications/wpndatabase.db'
connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=10)
connection.row_factory = sqlite3.Row
rows = connection.execute('''
    SELECT n.Id, n.ArrivalTime, n.Payload, h.PrimaryId
    FROM Notification n JOIN NotificationHandler h ON n.HandlerId=h.RecordId
    WHERE h.PrimaryId='cn.org.hermesagent.desktop'
    ORDER BY n.ArrivalTime DESC LIMIT 50
''').fetchall()
result = []
for row in rows:
    item = dict(row)
    payload = item['Payload']
    if isinstance(payload, bytes):
        payload = payload.decode('utf-8', errors='replace')
    item['Payload'] = payload or ''
    result.append(item)
print(json.dumps(result, ensure_ascii=True))
