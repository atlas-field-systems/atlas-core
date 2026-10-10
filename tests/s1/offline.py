"""Run a command in a network namespace with only loopback.

Usage: unshare --net python3 offline.py PORT SOCKET COMMAND...

Brings loopback up, relays 127.0.0.1:PORT to the Unix SOCKET that the test
connects to Core's published port outside the namespace, and runs COMMAND.
Nothing else in the namespace can reach any network.
"""

import fcntl
import socket
import struct
import subprocess
import sys
import threading

SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP = 0x8913, 0x8914, 0x1


def loopback_up():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        request = struct.pack("16sh", b"lo", 0)
        flags = struct.unpack("16sh", fcntl.ioctl(control, SIOCGIFFLAGS, request))[1]
        fcntl.ioctl(control, SIOCSIFFLAGS, struct.pack("16sh", b"lo", flags | IFF_UP))


def pipe(source, destination):
    try:
        while data := source.recv(65536):
            destination.sendall(data)
    except OSError:
        pass
    finally:
        for end in (source, destination):
            try:
                end.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def relay(port, path):
    listener = socket.create_server(("127.0.0.1", port))
    while True:
        client, _ = listener.accept()
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        upstream.connect(path)
        for source, destination in ((client, upstream), (upstream, client)):
            threading.Thread(target=pipe, args=(source, destination), daemon=True).start()


def main():
    port, path, command = int(sys.argv[1]), sys.argv[2], sys.argv[3:]
    loopback_up()
    threading.Thread(target=relay, args=(port, path), daemon=True).start()
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
