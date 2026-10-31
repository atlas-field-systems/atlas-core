import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

node, cli, evidence = sys.argv[1:]
os.makedirs(evidence, exist_ok=True)

class Terminal:
    def __init__(self, name, extra_env=None, existing=False):
        self.output = b''
        self.name = name
        self.existing = existing
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            error_file = os.open(os.path.join(evidence, name + '.stderr.log'), os.O_CREAT | os.O_WRONLY, 0o600)
            os.dup2(error_file, 2)
            os.close(error_file)
            env = {**os.environ, 'TERM': 'xterm-256color', 'CI': 'false', **(extra_env or {})}
            os.execve(node, [node, cli, 'tui', '--installation', os.path.join(evidence, name + '-absent')], env)
        self.resize(32, 110)

    def resize(self, rows, columns):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)

    def read(self, seconds=0.2):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([self.fd], [], [], max(0, end - time.monotonic()))
            if not ready:
                break
            try:
                self.output += os.read(self.fd, 65536)
            except OSError:
                break

    def until(self, text):
        end = time.monotonic() + 10
        while text.encode() not in self.output and time.monotonic() < end:
            self.read()
        assert text.encode() in self.output, (self.name, text, self.output[-1600:])

    def send(self, value):
        if len(value) > 1 and value.endswith('\r'):
            self.send(value[:-1])
            self.send('\r')
            return
        os.write(self.fd, value.encode())
        self.read(0.15)

    def finish(self, expected, close=False):
        if close:
            os.close(self.fd)
        else:
            self.send('\x03')
        end = time.monotonic() + 10
        while time.monotonic() < end:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                code = os.waitstatus_to_exitcode(status)
                break
            if close:
                time.sleep(0.05)
            else:
                self.read(0.1)
        else:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
            raise AssertionError('TUI did not settle owned work')
        if not close:
            self.read(0.1)
            os.close(self.fd)
        with open(os.path.join(evidence, self.name + '.log'), 'wb') as file:
            file.write(self.output)
        assert code == expected, (self.name, code, self.output[-1600:])
        if not self.existing:
            assert not os.path.exists(os.path.join(evidence, self.name + '-absent'))

setup = Terminal('guided-setup')
setup.until('Setup required')
setup.resize(40, 90)
setup.send('\r')
setup.until('Absolute certificate PEM path')
setup.send('/protected/certificate.pem\r')
setup.until('Absolute private key PEM path')
setup.send('/protected/private.key\r')
setup.until('API key UUID')
setup.send('\r')
setup.until('Request UUID')
setup.send('\r')
setup.until('32-byte base64url secret')
secret = 'm' * 42 + 's'
setup.send(secret)
assert secret.encode() not in setup.output
setup.send('\r')
setup.until('HTTPS bind address')
setup.send('\r')
setup.until('HTTPS port')
setup.send('\r')
setup.until('Trusted browser origins')
setup.send('\r')
setup.until('Core remains stopped')
setup.until('https://0.0.0.0:7443')
setup.send('\x1b')
setup.finish(130)
assert secret.encode() not in setup.output

fixture = os.environ.get('ATLAS_PTY_SETTINGS_FIXTURE')
if fixture:
    import shutil
    installation = os.path.join(evidence, 'settings-absent')
    os.makedirs(os.path.join(installation, 'setup'), mode=0o700)
    shutil.copyfile(fixture, os.path.join(installation, 'setup', 'settings.json'))
    with open(os.path.join(installation, 'setup', 'installation.json'), 'w') as file:
        json.dump({'format': 1, 'installation_id': 'c5d23a5c-d7d6-443a-9b97-ebf37a1a41bc', 'image': 'sha256:' + 'a' * 64}, file)
    editor = Terminal('settings', existing=True)
    editor.until('  Settings')
    for _ in range(7):
        editor.send('\x1b[B')
    editor.send('\r')
    editor.until('Saved revision 0')
    editor.send('\r')
    editor.until('host')
    for _ in range(9):
        editor.send('\x7f')
    editor.send('"127.0.0.1"')
    editor.send('\r')
    editor.until('https://127.0.0.1:7443')
    editor.send('y')
    editor.until('Operation completed.')
    editor.finish(130)
    with open(os.path.join(installation, 'setup', 'settings.json')) as file:
        saved = json.load(file)
    assert saved['revision'] == '1'
    assert saved['saved']['host'] == '127.0.0.1'
    assert saved['effective'] is None

lost = Terminal('terminal-loss')
lost.until('Setup required')
lost.finish(130, close=True)

slow = os.path.join(evidence, 'slow-npm.mjs')
with open(slow, 'w') as file:
    file.write("setTimeout(() => process.stdout.write('11.19.0\\n'), 700);\n")
escape = Terminal('escape-doctor', {'npm_execpath': slow})
escape.until('Setup required')
escape.send('\x1b[B')
escape.send('\x1b[B')
escape.send('\r')
escape.until('Working.')
escape.send('\x1b')
escape.until('Last operation result')
escape.until('command_failed')
assert os.waitpid(escape.pid, os.WNOHANG)[0] == 0, 'Escape must return home after settlement'
escape.send('\r')
escape.until('Absolute certificate PEM path')
escape.finish(1)
doctor = Terminal('cancel-doctor', {'npm_execpath': slow})
doctor.until('Setup required')
doctor.send('\x1b[B')
doctor.send('\x1b[B')
doctor.send('\r')
doctor.until('Working.')
doctor.finish(1)
print(json.dumps({'pty': 'pass', 'setup': 'guided and cancelled before mutation', 'secret': 'masked', 'resize': 'pass', 'terminalLoss': 130, 'cancelledDoctorFailure': 1}))
