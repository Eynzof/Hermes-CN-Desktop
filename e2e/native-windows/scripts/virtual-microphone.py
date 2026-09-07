"""Feed a SAPI test utterance through the Windows VB-CABLE virtual mic driver.

No browser/media/API mocks and no change to the system default audio devices.
The input endpoint must already be the user's chosen test microphone.
"""
import argparse
import array
import hashlib
import json
import time
import wave
from pathlib import Path

import pyaudiowpatch as pa
import win32com.client

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path('C:/HermesE2E'))
parser.add_argument('--prepare', action='store_true')
parser.add_argument('--verify', action='store_true')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
folder = args.root / 'voice-fixture'
file = folder / 'utterance.wav'
phrase = '这是语音输入测试。请只回复语音测试通过。'
if args.prepare:
    folder.mkdir(exist_ok=True)
    voice = win32com.client.Dispatch('SAPI.SpVoice')
    voices = [item for item in voice.GetVoices() if 'Huihui' in item.GetDescription()]
    if len(voices) != 1:
        raise SystemExit('The pinned native Chinese test voice is unavailable')
    voice.Voice = voices[0]
    stream = win32com.client.Dispatch('SAPI.SpFileStream')
    stream.Format.Type = 38  # SAPI 48 kHz / 16 bit / mono; verify WAV below.
    stream.Open(str(file), 3, False)
    voice.AudioOutputStream = stream
    voice.Speak(phrase)
    stream.Close()

with wave.open(str(file), 'rb') as source:
    rate, channels, width = source.getframerate(), source.getnchannels(), source.getsampwidth()
    assert (rate, channels, width) == (48000, 1, 2)
    pcm = source.readframes(source.getnframes())
samples = array.array('h', pcm)
stereo = array.array('h', (value for sample in samples for value in (sample, sample))).tobytes()
assert 1 < len(samples) / rate < 12
recorded = []


def capture(data, count, clock, status):
    recorded.append(data)
    return None, pa.paContinue


with pa.PyAudio() as audio:
    devices = [audio.get_device_info_by_index(i) for i in range(audio.get_device_count())]
    matches = [item for item in devices if item['hostApi'] == audio.get_host_api_info_by_type(pa.paWASAPI)['index']
               and item['name'] in ('CABLE Input (VB-Audio Virtual Cable)', 'CABLE Output (VB-Audio Virtual Cable)') and not item.get('isLoopbackDevice')]
    inputs = [item for item in matches if item['maxInputChannels'] > 0]
    outputs = [item for item in matches if item['maxOutputChannels'] > 0]
    assert len(inputs) == len(outputs) == 1, 'Existing virtual microphone input/output pair is required'
    assert 'CABLE Output' in audio.get_default_input_device_info()['name'], 'Default input differs; do not silently change it'
    input_rate = int(inputs[0]['defaultSampleRate'])
    input_channels = inputs[0]['maxInputChannels']
    assert (input_rate, input_channels) == (48000, 2), 'Use the pinned 48 kHz stereo VB-CABLE recording format'
    evidence = dict(phrase=phrase, source='Windows SAPI Microsoft Huihui Desktop', wavSha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                    inputDevice=inputs[0], outputDevice=outputs[0], durationSeconds=len(samples) / rate)
    if args.prepare:
        (folder / 'metadata.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    input_stream = None
    if args.verify:
        input_stream = audio.open(format=pa.paInt16, channels=input_channels, rate=input_rate, input=True,
                                  input_device_index=inputs[0]['index'], frames_per_buffer=512, stream_callback=capture)
    try:
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.with_suffix('.started.json').write_text(json.dumps(dict(started=time.time())), encoding='utf-8')
        with audio.open(format=pa.paInt16, channels=2, rate=rate, output=True, output_device_index=outputs[0]['index']) as output:
            output.write(stereo)
        if args.verify:
            time.sleep(0.5)
    finally:
        if input_stream:
            input_stream.stop_stream()
            input_stream.close()
    if args.verify:
        actual = array.array('h', b''.join(recorded))
        evidence.update(inputPeak=max((abs(value) for value in actual), default=0) / 32768, recordedFrames=len(actual) // input_channels)
        destination = args.output or folder / 'calibration'
        with wave.open(str(destination.with_suffix('.wav')), 'wb') as target:
            target.setnchannels(input_channels); target.setsampwidth(2); target.setframerate(input_rate); target.writeframes(actual.tobytes())
        destination.with_suffix('.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
        assert evidence['inputPeak'] > 0.005, 'Virtual output did not reach the actual microphone input'
    print(json.dumps(evidence, ensure_ascii=True))
