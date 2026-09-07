"""Capture actual WASAPI speaker output during a bounded notification test."""
import argparse
import array
import json
import math
import time
import wave
from pathlib import Path

import pyaudiowpatch as pa

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--seconds', type=float, default=4)
args = parser.parse_args()
if not 1 <= args.seconds <= 15:
    raise SystemExit('Capture is limited to 1–15 seconds of the test interval')
args.output.parent.mkdir(parents=True, exist_ok=True)
frames, levels = [], []
started = time.time()


def capture(data, frame_count, clock, status):
    samples = array.array('h', data)
    frames.append(data)
    levels.append(dict(utc=time.time(), frames=frame_count, status=status,
                       peak=max((abs(value) for value in samples), default=0) / 32768,
                       rms=math.sqrt(sum(value * value for value in samples) / max(1, len(samples))) / 32768))
    return (None, pa.paContinue)


with pa.PyAudio() as audio:
    device = audio.get_default_wasapi_loopback()
    rate, channels = int(device['defaultSampleRate']), device['maxInputChannels']
    with audio.open(format=pa.paInt16, channels=channels, rate=rate, input=True,
                    input_device_index=device['index'], frames_per_buffer=512,
                    stream_callback=capture):
        args.output.with_suffix('.ready.json').write_text(json.dumps(dict(device=device, started=started)), encoding='utf-8')
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            time.sleep(0.05)
    with wave.open(str(args.output.with_suffix('.wav')), 'wb') as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b''.join(frames))
    evidence = dict(device=device, started=started, ended=time.time(), blocks=levels,
                    peak=max((item['peak'] for item in levels), default=0),
                    maxRms=max((item['rms'] for item in levels), default=0),
                    totalFrames=sum(item['frames'] for item in levels))
    args.output.with_suffix('.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps({key: evidence[key] for key in ('peak', 'maxRms', 'totalFrames')}))
