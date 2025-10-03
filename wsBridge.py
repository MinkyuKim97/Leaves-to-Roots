#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import asyncio, json, sys, time
import serial, serial.tools.list_ports
import websockets

BAUD = 115200
TIMEOUT_S = 5.0
clients = set()

# 서버 상태
current_mode = "read"
staged_write_payload = None
SIM_READ_TEMPLATE = lambda: {"sim":"read_demo","ts":int(time.time())}

# ---------- 직렬 I/O ----------
class Uno:
    def __init__(self, port: str):
        self.ser = serial.Serial(port, BAUD, timeout=0.1)
    # def read_line(self) -> str:
    #     try:
    #         raw = self.ser.readline()
    #         if not raw: return ""
    #         return raw.decode("utf-8", errors="ignore").strip()
    #     except Exception:
    #         return ""
    def write_line(self, s: str):
        self.ser.write((s + "\n").encode("utf-8"))

    def read_line(self) -> str:
        return self.ser.readline().decode(errors="ignore").strip()



    
def list_ports():
    return list(serial.tools.list_ports.comports())

def pick_port() -> str:
    ports = list_ports()
    if not ports:
        print("No serial ports found", file=sys.stderr); sys.exit(1)
    prio = (0x2341, 0x1A86, 0x10C4, 0x0403)
    for p in ports:
        if getattr(p, "vid", None) in prio:
            return p.device
    return ports[0].device

async def ws_broadcast(obj):
    if not clients: return
    msg = json.dumps(obj, ensure_ascii=False)
    await asyncio.gather(*[ws.send(msg) for ws in list(clients)], return_exceptions=True)
    # async def handle(ws):
    #     await ws.send(json.dumps({"Broadcast": True, "info": "Works"}))
# ---------- 시리얼 폴링 ----------
async def serial_poller(uno: Uno):
    global current_mode, staged_write_payload
    while True:
        ln = uno.read_line()
        if not ln:
            await asyncio.sleep(0.02); continue

      
        if ln == "0":
            current_mode = "read"
            # async def handle(ws):
            #      await ws.send(json.dumps({"Broadcast": True, "info": current_mode}))

            await ws_broadcast({"event":"mode","mode":current_mode})
            await ws_broadcast({"info":"mode -> read"})
            continue
        if ln == "1":
            current_mode = "write"
            await ws_broadcast({"event":"mode","mode":current_mode})
            await ws_broadcast({"info":"mode -> write"})
            continue
        if ln == "2":
            await ws_broadcast({"event":"execute","mode":current_mode})
            # await ws_broadcast({"info":"mode -> write"})

            # payload = SIM_READ_TEMPLATE()
            # await ws_broadcast({"ok":True, "op":"read", "json": json.dumps(payload, ensure_ascii=False)})
            continue
        # if ln == "3":
        #     # EXEC WRITE (NFC 없음 → stage_write된 페이로드 필요)
        #     if staged_write_payload is None:
        #         await ws_broadcast({"ok":False,"op":"write","error":"no staged payload"})
        #     else:
        #         await ws_broadcast({"ok":True,"op":"write","info":"written(simulated)","bytes":len(staged_write_payload.encode("utf-8"))})
        #     continue

        # 그 외 라인은 일반 로그로 패스스루
        await ws_broadcast({"serial": ln})

def to_hex(b: bytes) -> str:
    return b.hex().upper()

# ---------- WebSocket 핸들러 (기존 op 유지) ----------
def make_handler(uno: Uno):
    async def handle(ws):
        await ws.send(json.dumps({"ok": True, "info": f"serial:{uno.ser.port}"}))
        global staged_write_payload, current_mode
        clients.add(ws)

        try:
            await ws.send(json.dumps({"event":"mode","mode":current_mode}))
            async for raw in ws:
                try:
                    req = json.loads(raw)
                except Exception:
                    await ws.send(json.dumps({"ok": False, "error": "invalid json"}))
                    continue

                # ------------ WRITE ------------
                if req.get("op") == "write":
                    payload = req.get("json", "")
                    try:
                        json.dumps(json.loads(payload))
                    except Exception:
                        await ws.send(json.dumps({"ok": False, "op": "write", "error": "json parse error"}))
                        continue

                    await ws.send(json.dumps({"info": "waiting_for_tag", "Mode": "write"}))
                    hexdata = to_hex(payload.encode("utf-8"))
                    uno.write_line(f"W:{hexdata}")

                    t0, final_sent = time.time(), False
                    while time.time() - t0 < TIMEOUT_S:
                        ln = uno.read_line()
                        if not ln:
                            await asyncio.sleep(0.02); continue
                        await ws.send(ln)
                     
                        try:
                            obj = json.loads(ln)
                            if obj.get("op") == "write" and obj.get("ok") is not None:
                                final_sent = True; break
                        except Exception:
                            pass
                    if not final_sent:
                        await ws.send(json.dumps({"ok": False, "op": "write", "error": "timeout waiting UNO"}))

                # ------------ READ ------------
                elif req.get("op") == "read":
                    await ws.send(json.dumps({"info": "waiting_for_tag", "Mode": "read"}))
                    uno.write_line("R")

                    t0, final_sent = time.time(), False
                    while time.time() - t0 < TIMEOUT_S:
                        ln = uno.read_line()
                        if not ln:
                            await asyncio.sleep(0.02); continue
                        await ws.send(ln)
                        try:
                            obj = json.loads(ln)
                            if obj.get("op") == "read" and obj.get("ok") is True:
                                final_sent = True; break
                        except Exception:
                            pass
                    if not final_sent:
                        await ws.send(json.dumps({"ok": False, "op": "read", "error": "timeout waiting UNO"}))

                else:
                    await ws.send(json.dumps({"ok": False, "error": "unknown op"}))
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            clients.discard(ws)
    return handle

async def main():
    uno = Uno(pick_port())
    asyncio.get_event_loop().create_task(serial_poller(uno))
    async with websockets.serve(make_handler(uno), "0.0.0.0", 8080):
    # async with websockets.serve(make_handler(), "0.0.0.0", 8080):
        print("WebSocket: ws://localhost:8080")
        print(f"Serial: {uno.ser.port} @ {uno.ser.baudrate}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutdown")