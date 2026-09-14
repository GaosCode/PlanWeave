#!/usr/bin/env python3
"""Bounded Linux/macOS TCP evidence alongside a Desktop collaboration capture.

Writes packet header summaries only (no payload), socket counters and path state.
IP addresses and ports are intentionally retained for connection correlation.
"""
import argparse
import datetime
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=3, check=False)
        return {"command": args, "exitCode": result.returncode,
                "stdout": result.stdout[:65536], "stderr": result.stderr[:4096],
                "truncated": len(result.stdout) > 65536}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"command": args, "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-id", required=True)
    parser.add_argument("--peer", action="append", required=True, type=ipaddress.ip_address)
    parser.add_argument("--port", type=int, default=443)
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--interface", help="tcpdump interface; Linux defaults to any")
    parser.add_argument("--container", help="Linux Server container name for network-namespace ss")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,48}", args.capture_id):
        parser.error("invalid capture ID")
    if not 1 <= args.seconds <= 180 or not 1 <= args.port <= 65535:
        parser.error("seconds must be 1..180 and port 1..65535")
    if platform.system() not in ("Linux", "Darwin"):
        parser.error("use capture-collaboration-network.ps1 on Windows")
    args.output.mkdir(parents=True, exist_ok=False)
    peers = [str(peer) for peer in args.peer]
    started = time.monotonic()
    manifest = {"schemaVersion": "planweave.network.capture/v1", "captureId": args.capture_id,
                "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "platform": platform.system(), "peers": peers, "port": args.port,
                "seconds": args.seconds, "privacy": "IP/port and TCP headers only; no payload",
                "limits": "16 MiB packet summaries; socket samples every 500ms; command timeout 3s",
                "preflight": [], "coverage": {}}
    interface = args.interface
    if not interface:
        if platform.system() == "Linux":
            interface = "any"
        else:
            route = command(["route", "-n", "get", peers[0]])
            manifest["preflight"].append(route)
            match = re.search(r"interface:\s+(\S+)", route.get("stdout", ""))
            interface = match.group(1) if match else None
    tcpdump = shutil.which("tcpdump")
    packet = None
    with (args.output / "tcp-headers.txt").open("w") as output, (args.output / "tcpdump-status.txt").open("w") as errors:
        if tcpdump and interface:
            # Default tcpdump output prints protocol headers, not application payload.
            packet = subprocess.Popen([tcpdump, "-l", "-n", "-tt", "-S", "-s", "96", "-i", interface,
                                       f"tcp port {args.port} and (" + " or ".join("host " + p for p in peers) + ")"],
                                      stdout=output, stderr=errors)
        else:
            manifest["coverage"]["packets"] = "unavailable: tcpdump or interface missing"
        socket_command = ["ss", "-tin", f"( sport = :{args.port} or dport = :{args.port} ) and ( " + " or ".join("dst " + peer for peer in peers) + " )"]
        if args.container and platform.system() == "Linux":
            inspect = command(["docker", "inspect", "--format", "{{.State.Pid}}", args.container])
            manifest["preflight"].append(inspect)
            pid = inspect.get("stdout", "").strip()
            if inspect.get("exitCode") == 0 and pid.isdigit() and int(pid) > 0:
                socket_command = ["nsenter", "-t", pid, "-n", "--"] + socket_command
            else:
                manifest["coverage"]["containerSockets"] = "unavailable: cannot resolve running container PID"
        if platform.system() == "Darwin":
            socket_command = ["netstat", "-anv", "-p", "tcp"]
        try:
            with (args.output / "samples.jsonl").open("w") as samples:
                index = 0
                while time.monotonic() - started < args.seconds:
                    tick = time.monotonic()
                    sample = {"atMs": (tick - started) * 1000,
                              "atUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                              "sockets": command(socket_command)}
                    if platform.system() == "Darwin" and "stdout" in sample["sockets"]:
                        sample["sockets"]["stdout"] = "\n".join(
                            line for line in sample["sockets"]["stdout"].splitlines()
                            if any(peer in line for peer in peers))
                    if index % 10 == 0:
                        sample["tcpCountersSystemWide"] = command(["netstat", "-s", "-p", "tcp"] if platform.system() == "Darwin" else ["nstat", "-az"])
                        status = command(["tailscale", "status", "--json"])
                        if status.get("exitCode") == 0:
                            try:
                                data = json.loads(status.pop("stdout"))
                                status["peers"] = [{key: peer.get(key) for key in ["TailscaleIPs", "Online", "Active", "CurAddr", "Relay", "RxBytes", "TxBytes"]}
                                                   for peer in data.get("Peer", {}).values()
                                                   if set(peer.get("TailscaleIPs", [])) & set(peers)]
                            except (ValueError, AttributeError) as error:
                                status["error"] = "invalid tailscale status: " + str(error)
                        sample["path"] = status
                    samples.write(json.dumps(sample) + "\n")
                    samples.flush()
                    index += 1
                    if packet and packet.poll() is None and output.tell() > 16 * 1024 * 1024:
                        manifest["coverage"]["packets"] = "truncated: size limit"
                        packet.terminate()
                    time.sleep(max(0, .5 - (time.monotonic() - tick)))
        except KeyboardInterrupt:
            manifest["interrupted"] = True
        finally:
            if packet:
                if packet.poll() is None:
                    packet.terminate()
                try:
                    packet.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    packet.kill()
                    packet.wait()
                manifest["coverage"]["tcpdumpExitCode"] = packet.returncode
                manifest["coverage"]["packetSummaryBytes"] = os.fstat(output.fileno()).st_size
                manifest["coverage"]["packetStatusFile"] = "tcpdump-status.txt"
            manifest["durationMs"] = (time.monotonic() - started) * 1000
            (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(args.output)


if __name__ == "__main__":
    main()
