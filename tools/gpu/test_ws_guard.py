"""The GPU sidecars' WebSocket guard (tools/gpu/ws_guard.py, used by a2f_sidecar.py and vision_sidecar.py): a website's Origin is refused,
a loopback page or a program may connect, a program cannot take the studio's connection away but a studio page can, and a binary audio
message that is empty / not whole float32 samples is skipped while NaN / inf are zeroed. A tiny server uses the real helpers; no model,
no GPU, an ephemeral port. Run: python tools/gpu/test_ws_guard.py   (needs `websockets` and `numpy`)"""
import asyncio
import os
import struct
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ws_guard import guard, may_replace, origin_ok, pcm_from_message  # noqa: E402

fails = 0


def ok(cond, name, extra=''):
    global fails
    if isinstance(cond, str):   # (called as ok(name, cond))
        cond, name = name, cond
    print(('PASS  ' if cond else 'FAIL  ') + name + (f'  ({extra})' if extra and not cond else ''))
    if not cond:
        fails += 1


ok('no Origin (a program) is allowed', origin_ok(None) and origin_ok(''))
ok('loopback pages are allowed', all(origin_ok(o) for o in ('http://localhost:5190', 'http://127.0.0.1:5191', 'http://[::1]:5191', 'https://localhost')))
ok('a website is refused', not any(origin_ok(o) for o in ('https://evil.example', 'https://example.com', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'null')))

m = pcm_from_message(struct.pack('<4f', 0.5, float('nan'), float('inf'), -float('inf')))
ok(m is not None and list(m) == [0.5, 0.0, 0.0, 0.0], 'NaN / inf in audio are zeroed before the engine sees them')
ok(pcm_from_message(b'') is None and pcm_from_message(b'\x00\x00\x00') is None and pcm_from_message(b'\x00' * 7) is None, 'empty or not-a-multiple-of-4 messages are skipped')
ok(pcm_from_message(b'\x00' * 8) is not None and len(pcm_from_message(b'\x00' * 8)) == 2, 'a whole float32 message is taken')


async def main():
    import websockets
    from websockets.asyncio.client import connect
    current = {'ws': None}
    got = []

    async def handler(ws):
        old = current['ws']
        if old is not None:
            if not may_replace(ws):
                await ws.close(4001, 'another studio is connected')
                return
            await old.close(4000, 'replaced by a newer studio')
        current['ws'] = ws
        try:
            async for msg in ws:
                got.append(msg)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if current['ws'] is ws:
                current['ws'] = None

    async with websockets.serve(handler, '127.0.0.1', 0, process_request=guard('/a2f')) as server:
        port = server.sockets[0].getsockname()[1]
        uri = f'ws://127.0.0.1:{port}/a2f'
        try:
            async with connect(uri, origin='https://evil.example'):
                ok(False, 'a website page is refused (HTTP 403)', 'connected')
        except Exception as e:  # noqa: BLE001
            ok('403' in str(e), 'a website page is refused (HTTP 403)', str(e))
        try:
            async with connect(f'ws://127.0.0.1:{port}/other'):
                ok(False, 'another path is refused (404)', 'connected')
        except Exception as e:  # noqa: BLE001
            ok('404' in str(e), 'another path is refused (404)', str(e))
        # the studio (a loopback page) connects
        studio = await connect(uri, origin=f'http://127.0.0.1:{port}')
        await studio.send(b'\x00' * 8)
        await asyncio.sleep(0.1)
        ok(current['ws'] is not None and len(got) == 1, 'a loopback page connects and is served')
        # a program (no Origin) cannot take it over
        prog = await connect(uri)
        try:
            await asyncio.wait_for(prog.recv(), 2)
            ok(False, 'a program cannot replace the studio', 'not closed')
        except Exception:  # noqa: BLE001
            ok(prog.close_code == 4001, 'a program cannot replace the studio', str(prog.close_code))
        await studio.send(b'\x00' * 4)
        await asyncio.sleep(0.1)
        ok(len(got) == 2, 'the studio is still connected and served after the program was turned away')
        # another studio page replaces it
        studio2 = await connect(uri, origin='http://localhost:5190')
        await asyncio.sleep(0.2)
        ok(studio.close_code == 4000, 'a new studio page replaces the old one', str(studio.close_code))
        await studio2.close()
        # once the studio is gone, a program may connect
        await asyncio.sleep(0.2)
        prog2 = await connect(uri)
        await prog2.send(b'\x00' * 4)
        await asyncio.sleep(0.1)
        ok(current['ws'] is not None, 'with no studio connected a program may connect')
        await prog2.close()


asyncio.run(main())
print('all checks passed' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
