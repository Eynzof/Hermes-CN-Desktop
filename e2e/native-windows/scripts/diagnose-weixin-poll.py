"""Measure the real official QR long poll; never substitutes for Desktop."""
from datetime import datetime, timezone
import json
import time
import urllib.parse
import urllib.request

base = "https://ilinkai.weixin.qq.com/ilink/bot/"
headers = {"iLink-App-Id": "bot", "iLink-App-ClientVersion": "131584"}
records = []


def get(endpoint):
    started = time.monotonic()
    try:
        with urllib.request.urlopen(urllib.request.Request(base + endpoint, headers=headers), timeout=45) as response:
            body, status = json.load(response), response.status
        records.append({"operation": endpoint.split("?")[0], "ms": round((time.monotonic() - started) * 1000),
            "httpStatus": status, "responseStatus": body.get("status"), "errorCode": body.get("errcode")})
        return body
    except Exception as error:
        records.append({"operation": endpoint.split("?")[0], "ms": round((time.monotonic() - started) * 1000), "error": str(error)})
        raise


try:
    qr = get("get_bot_qrcode?bot_type=3")
    get("get_qrcode_status?qrcode=" + urllib.parse.quote(qr["qrcode"]))
finally:
    print(json.dumps({"kind": "official-service-diagnostic-not-desktop-pass", "timeoutSeconds": 45,
        "completedAt": datetime.now(timezone.utc).isoformat(), "requests": records}, indent=2))
