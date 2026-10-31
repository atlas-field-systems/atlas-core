import copy
import fcntl
import http.server
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import termios
import threading
import time

node, cli, evidence = sys.argv[1:]
os.makedirs(evidence, exist_ok=True)
image = 'sha256:' + 'a' * 64
dataset = '0b9ee0f6-5b4c-4d24-8b0c-2d6a2f1f9d11'
stub_directory = os.path.join(evidence, 'bin')
os.makedirs(stub_directory, exist_ok=True)
with open(os.path.join(stub_directory, 'sudo'), 'w') as file:
    file.write('''#!/usr/bin/env python3
import json, os, sys
path = os.environ.get('ATLAS_PTY_DOCKER')
args = sys.argv[3:]
if not path or sys.argv[1:3] != ['-n', 'docker']:
    sys.exit(1)
with open(path) as file:
    state = json.load(file)
with open(path + '.log', 'a') as file:
    file.write(' '.join(args) + '\\n')
def save():
    with open(path + '.tmp', 'w') as file:
        json.dump(state, file)
    os.replace(path + '.tmp', path)
verb = args[0]
containers = state['containers']
if verb == 'info':
    print('fixture')
elif verb == 'image':
    labels = {'org.opencontainers.image.revision': state['revision']}
    print(json.dumps([{'Id': args[2], 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': labels}}]))
elif verb == 'create':
    container = format(state['next'], '064x')
    state['next'] += 1
    labels = dict(value.split('=', 1) for flag, value in zip(args, args[1:]) if flag == '--label')
    containers[container] = {'labels': labels, 'running': False, 'pid': 0}
    save()
    print(container)
elif verb == 'start' and '--attach' in args:
    sys.stdin.read()
    mode = containers[args[-1]]['labels']['atlas.mode']
    print(json.dumps({'provisioned': True} if mode == 'provision' else {'exists': True, 'dataset': state['dataset'], 'marker': None}))
elif verb == 'start':
    containers[args[-1]].update(running=True, pid=state['pid'])
    save()
elif verb == 'inspect':
    entry = containers[args[1]]
    print(json.dumps([{'Id': args[1], 'State': {'Running': entry['running'], 'Pid': entry['pid'], 'ExitCode': 0},
        'Config': {'Labels': entry['labels']}, 'HostConfig': {'LogConfig': {'Type': 'none'}, 'RestartPolicy': {'Name': 'no'}}}]))
elif verb == 'ps':
    wanted = next(value[3:] for value in args if value.startswith('id='))
    print(wanted if wanted in containers else '')
elif verb == 'rm':
    del containers[args[1]]
    save()
else:
    sys.exit(1)
''')
os.chmod(os.path.join(stub_directory, 'sudo'), 0o700)

class Maintenance(http.server.BaseHTTPRequestHandler):
    def address_string(self):
        return 'local'

    def log_message(self, *args):
        pass

    def do_POST(self):
        core = self.server.core
        operation = json.loads(self.rfile.read(int(self.headers['Content-Length'])))['operation']
        if operation == 'release-export' and core.release_failure:
            self.connection.shutdown(socket.SHUT_RDWR)
            self.close_connection = True
            return
        data = {'ready': core.ready, 'dataset': dataset} if operation == 'inspect' else {}
        body = json.dumps({'ok': True, 'data': data}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        if operation == 'stop':
            core.stopping.set()
            threading.Thread(target=core.exit, daemon=True).start()

class MaintenanceServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

class Core:
    def __init__(self, installation):
        self.installation = installation
        self.path = installation + '-docker.json'
        self.ready = True
        self.stop_delay = 0
        self.release_failure = False
        self.stopping = threading.Event()
        self.child = None
        self.server = None
        with open(os.path.join(os.path.dirname(os.path.realpath(cli)), 'operator-release.json')) as file:
            revision = json.load(file)['sourceRevision']
        self.write({'containers': {}, 'next': 1, 'pid': 0, 'dataset': dataset, 'revision': revision})
        threading.Thread(target=self.watch, daemon=True).start()

    def state(self):
        with open(self.path) as file:
            return json.load(file)

    def write(self, state):
        with open(self.path + '.core', 'w') as file:
            json.dump(state, file)
        os.replace(self.path + '.core', self.path)

    def log(self):
        with open(self.path + '.log') as file:
            return file.read()

    def prepare_start(self):
        self.child = subprocess.Popen(['sleep', '600'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.write({**self.state(), 'pid': self.child.pid})

    def serving(self):
        return any(entry['running'] for entry in self.state()['containers'].values())

    def watch(self):
        while True:
            if self.server is None and self.serving():
                self.listen()
            time.sleep(0.02)

    def listen(self):
        control = os.open(os.path.join(self.installation, 'control'), os.O_RDONLY)
        path = f'/proc/self/fd/{control}/maintenance.sock'
        if os.path.exists(path):
            os.unlink(path)
        self.server = MaintenanceServer(path, Maintenance)
        self.server.core = self
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def exit(self):
        time.sleep(self.stop_delay)
        self.server.shutdown()
        self.server.server_close()
        self.server = None
        state = self.state()
        for entry in state['containers'].values():
            entry['running'] = False
        self.write(state)
        self.child.kill()
        self.child.wait()

    def close(self):
        if self.child:
            self.child.kill()
            self.child.wait()

labels = ['Set up Core', 'Start Core', 'Stop Core', 'Restart Core', 'Settings', 'Add credential', 'Diagnostics',
    'Check installation', 'Export diagnostics', 'Replace certificate', 'Refresh status', 'Back', 'Exit']
rows = re.compile(r'^\s*(?:❯\s+)?(' + '|'.join(labels) + r')\s*$', re.M)
ansi = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')
setup_menu = ['Set up Core', 'Check installation', 'Exit']
stopped_menu = ['Start Core', 'Settings', 'Add credential', 'Diagnostics', 'Refresh status', 'Exit']
running_menu = ['Stop Core', 'Restart Core', 'Settings', 'Add credential', 'Diagnostics', 'Refresh status', 'Exit']
unknown_menu = ['Settings', 'Diagnostics', 'Refresh status', 'Exit']
diagnostics_menu = ['Check installation', 'Export diagnostics', 'Back']
retired = [b'Force Stop', b'Hard Reset', b'Enroll Asset', b'Revoke enrollment', b'Inspect enrollment', b'API key UUID', b'Request UUID', b'api_key_id', b'request_id']

class Terminal:
    def __init__(self, name, extra_env=None, existing=False, root=None):
        self.output = b''
        self.mark = 0
        self.name = name
        self.existing = existing
        self.root = root or os.path.join(evidence, name + '-absent')
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            error_file = os.open(os.path.join(evidence, name + '.stderr.log'), os.O_CREAT | os.O_WRONLY, 0o600)
            os.dup2(error_file, 2)
            os.close(error_file)
            env = {**os.environ, 'TERM': 'xterm-256color', 'CI': 'false', **(extra_env or {})}
            env['PATH'] = stub_directory + os.pathsep + env['PATH']
            os.execve(node, [node, cli, 'tui', '--installation', self.root], env)
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

    def text(self):
        return ansi.sub('', self.output[self.mark:].decode('utf8', 'replace'))

    def until(self, text):
        end = time.monotonic() + 15
        while ' '.join(self.text().split()).find(text) < 0 and time.monotonic() < end:
            self.read()
        assert ' '.join(self.text().split()).find(text) >= 0, (self.name, text, self.text()[-1600:])

    def step(self):
        self.read(0.05)
        self.mark = len(self.output)

    def send(self, value):
        if len(value) > 1 and value.endswith('\r'):
            self.send(value[:-1])
            self.send('\r')
            return
        os.write(self.fd, value.encode())
        self.read(0.15)

    def menu(self, expected):
        end = time.monotonic() + 15
        shown = []
        while time.monotonic() < end:
            self.read(0.2)
            shown = rows.findall(self.text().rsplit('Atlas Core', 1)[-1])
            if shown == expected:
                return
        assert shown == expected, (self.name, expected, shown)

    def press(self, expected, label):
        self.menu(expected)
        self.select(expected.index(label))

    def select(self, index):
        for _ in range(index):
            self.send('\x1b[B')
        self.step()
        self.send('\r')

    def replace(self, length, value):
        for _ in range(length):
            self.send('\x7f')
        self.send(value + '\r')

    def alive(self):
        return os.waitpid(self.pid, os.WNOHANG)[0] == 0

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
        for forbidden in retired + [b'"event"', b'"severity"', b'"component"']:
            assert forbidden not in self.output, (self.name, forbidden)
        if not self.existing:
            assert not os.path.exists(self.root)

def read_json(*path):
    with open(os.path.join(*path)) as file:
        return json.load(file)

def write_json(value, *path):
    with open(os.path.join(*path), 'w') as file:
        json.dump(value, file)

def file_bytes(*path):
    with open(os.path.join(*path), 'rb') as file:
        return file.read()

def certificate(name):
    directory = os.path.join(evidence, 'tls', name)
    os.makedirs(directory, mode=0o700)
    pair = (os.path.join(directory, 'certificate.pem'), os.path.join(directory, 'private.key'))
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost',
        '-keyout', pair[1], '-out', pair[0]], check=True, capture_output=True)
    os.chmod(pair[1], 0o600)
    return pair

def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]

secret = 'm' * 42 + 's'
setup = Terminal('guided-setup')
setup.until('Setup required')
setup.resize(24, 44)
setup.press(setup_menu, 'Set up Core')
setup.until('Absolute certificate PEM path')
setup.send('relative.pem\r')
setup.until('Enter an absolute path.')
setup.replace(len('relative.pem'), '/protected/certificate.pem')
setup.until('Absolute private key PEM path')
setup.send('/protected/private.key\r')
setup.until('32-byte base64url secret')
setup.send('too-short\r')
setup.until('Enter a 32-byte base64url secret.')
assert b'too-short' not in setup.output
setup.replace(len('too-short'), secret)
setup.until('HTTPS bind address')
setup.send('\r')
setup.until('HTTPS port')
setup.replace(4, 'nope')
setup.until('Enter a port from 1 to 65535.')
setup.replace(4, '0')
setup.until('Enter a port from 1 to 65535.')
setup.replace(1, '7443')
setup.until('Trusted browser origins, comma-separated')
setup.send('\r')
setup.until('Core remains stopped')
setup.until('https://0.0.0.0:7443')
setup.send('\x1b')
setup.menu(setup_menu)
setup.finish(130)
assert secret.encode() not in setup.output

fixture = read_json(os.environ['ATLAS_PTY_SETTINGS_FIXTURE'])
default_settings = copy.deepcopy(fixture['saved'])
fixture['revision'] = '9007199254740993'
fixture['saved']['openEnrollment'] = True
fixture['saved']['maxConnections'] = 31
fixture['saved']['limits']['max_changes'] = 999
fixture['saved']['temporary']['max_snapshot_bytes'] = '536870913'
previous = {'revision': '9007199254740992', 'value': {**copy.deepcopy(fixture['saved']), 'host': '10.0.0.7'}}
fixture['effective'] = previous
fixture['last_working'] = previous
fixture['apply_failure'] = 'start_failed'
installation = os.path.join(evidence, 'settings-absent')
setup_directory = os.path.join(installation, 'setup')
os.makedirs(setup_directory, mode=0o700)
write_json(fixture, setup_directory, 'settings.json')
write_json({'format': 1, 'installation_id': 'c5d23a5c-d7d6-443a-9b97-ebf37a1a41bc', 'image': image}, setup_directory, 'installation.json')
editor = Terminal('settings', existing=True)
editor.until('Status unavailable')
editor.until('Last start failed.')
editor.until('Open enrollment is on.')
editor.press(unknown_menu, 'Settings')
page = ['Replace certificate', 'Back']
editor.until('Last verified effective revision 9007199254740992')
editor.until('Saved revision 9007199254740993')
editor.until('Last working revision 9007199254740992: https://10.0.0.7:7443')
editor.until('Bind address: 0.0.0.0; last verified 10.0.0.7')
editor.menu(page)
before = file_bytes(setup_directory, 'settings.json')
editor.select(0)
editor.until('HTTPS bind address')
editor.replace(7, '127.0.0.1')
editor.until('Proposed https://127.0.0.1:7443')
editor.step()
editor.send('n')
editor.menu(page)
assert file_bytes(setup_directory, 'settings.json') == before, 'declined edit must not write'
editor.select(0)
editor.until('HTTPS bind address')
editor.send('\x1b')
editor.menu(page)
assert file_bytes(setup_directory, 'settings.json') == before, 'cancelled edit must not write'
editor.select(0)
editor.until('HTTPS bind address')
editor.replace(7, '127.0.0.1')
editor.until('Proposed https://127.0.0.1:7443')
editor.step()
editor.send('y')
editor.until('Settings saved. Not active until restart.')
editor.until('Saved revision 9007199254740994')
editor.menu(page)
editor.select(1)
editor.until('HTTPS port')
editor.replace(4, '9443')
editor.until('Proposed https://127.0.0.1:9443')
editor.step()
editor.send('y')
editor.until('Saved revision 9007199254740995')
editor.menu(page)
editor.select(2)
editor.until('Trusted browser origins, comma-separated')
editor.send('https://console.example/path\r')
editor.until('without a path')
editor.replace(len('https://console.example/path'), 'https://console.example, https://ops.example:8443')
editor.until('Save settings over revision 9007199254740995')
editor.step()
editor.send('y')
editor.until('Browser origins: https://console.example and 1 more; last verified none')
editor.menu(page)
editor.select(3)
editor.until('Diagnostic level')
editor.send('\x1b[B')
editor.send('\r')
editor.until('Save settings over revision 9007199254740996')
editor.step()
editor.send('y')
editor.until('Diagnostic level: DEBUG; last verified INFO')
saved = read_json(setup_directory, 'settings.json')
assert saved['revision'] == '9007199254740997'
assert saved['saved'] == {**fixture['saved'], 'host': '127.0.0.1', 'port': 9443,
    'trustedOrigins': ['https://console.example', 'https://ops.example:8443'], 'diagnosticLevel': 'DEBUG'}
assert saved['effective'] == previous and saved['last_working'] == previous
assert saved['apply_failure'] == 'apply_required'
editor.resize(24, 44)
editor.menu(page)
editor.select(1)
editor.until('HTTPS port')
elsewhere = {**saved, 'revision': '9007199254740998'}
write_json(elsewhere, setup_directory, 'settings.json')
editor.replace(4, '9444')
editor.step()
editor.send('y')
editor.until('settings_revision_changed')
editor.until('Saved settings changed elsewhere.')
editor.until('Saved revision 9007199254740998')
assert read_json(setup_directory, 'settings.json') == elsewhere, 'a stale draft must not overwrite'
editor.menu(page)
editor.finish(1)

recovering = os.path.join(evidence, 'recovery-absent')
os.makedirs(os.path.join(recovering, 'setup'), mode=0o700)
os.makedirs(os.path.join(recovering, 'recovery'), mode=0o700)
write_json(fixture, recovering, 'setup', 'settings.json')
write_json({'format': 1, 'installation_id': 'c5d23a5c-d7d6-443a-9b97-ebf37a1a41bc', 'image': image}, recovering, 'setup', 'installation.json')
action = {'format': 1, 'action_id': 'a7a3be4e-4f61-4c6a-9c0c-1e9fbb2a7b11', 'installation_id': 'c5d23a5c-d7d6-443a-9b97-ebf37a1a41bc',
    'kind': 'reset', 'old_dataset': None, 'intended_dataset': dataset, 'writer': None, 'image': image, 'phase': 'intent',
    'primary_failure': None, 'cleanup_failure': None}
write_json(action, recovering, 'recovery', 'action.json')
recovery_core = Core(recovering)
recovery = Terminal('recovery', {'ATLAS_PTY_DOCKER': recovery_core.path}, existing=True, root=recovering)
recovery.until('Recovery required')
recovery.until('Interrupted reset stopped at intent.')
recovery.until(f'Run: atlas-core recover --installation {recovering}')
recovery.until('leaves Core stopped')
recovery.menu(['Check installation', 'Refresh status', 'Exit'])
recovery.finish(130)
assert read_json(recovering, 'recovery', 'action.json') == action, 'the TUI must not start recovery'

reset_root = os.path.join(evidence, 'hard-reset')
for directory in ['setup', 'data', 'control', 'recovery']:
    os.makedirs(os.path.join(reset_root, directory), mode=0o700)
completed_reset = {**action, 'kind': 'hard-reset', 'phase': 'complete'}
write_json(completed_reset, reset_root, 'recovery', 'action.json')
reset_core = Core(reset_root)
reset = Terminal('after-hard-reset', {'ATLAS_PTY_DOCKER': reset_core.path}, existing=True, root=reset_root)
try:
    reset.until('Setup required')
    reset.menu(setup_menu)
    reset.press(setup_menu, 'Set up Core')
    reset.until('Absolute certificate PEM path')
finally:
    reset.finish(130)
assert read_json(reset_root, 'recovery', 'action.json') == completed_reset

lost = Terminal('terminal-loss')
lost.until('Setup required')
lost.finish(130, close=True)

slow = os.path.join(evidence, 'slow-npm.mjs')
with open(slow, 'w') as file:
    file.write("setTimeout(() => process.stdout.write('11.19.0\\n'), 700);\n")
escape = Terminal('escape-doctor', {'npm_execpath': slow})
escape.until('Setup required')
escape.press(setup_menu, 'Check installation')
escape.until('Working.')
escape.send('\x1b')
escape.until('Installation check failed.')
escape.until('prerequisite_failed')
escape.until('Install Docker Engine, start its daemon')
escape.menu(setup_menu)
assert escape.alive(), 'Escape must return home after settlement'
escape.select(0)
escape.until('Absolute certificate PEM path')
escape.finish(1)
doctor = Terminal('cancel-doctor', {'npm_execpath': slow})
doctor.until('Setup required')
doctor.press(setup_menu, 'Check installation')
doctor.until('Working.')
doctor.finish(1)

root = os.path.join(evidence, 'lifecycle-absent')
core = Core(root)
docker = {'ATLAS_PTY_DOCKER': core.path}
first = certificate('first')
second = certificate('second')
port = free_port()
live = Terminal('lifecycle', docker, existing=True, root=root)
live.until('Setup required')
live.press(setup_menu, 'Set up Core')
live.until('Absolute certificate PEM path')
live.send(first[0] + '\r')
live.until('Absolute private key PEM path')
live.send(first[1] + '\r')
live.until('32-byte base64url secret')
live.send(secret + '\r')
live.until('HTTPS bind address')
live.replace(7, '127.0.0.1')
live.until('HTTPS port')
live.replace(4, str(port))
live.until('Trusted browser origins, comma-separated')
live.send('https://console.example\r')
live.until(f'Proposed https://127.0.0.1:{port}')
live.step()
live.send('y')
live.until('Setup complete. Core remains stopped.')
assert re.search(r'API key ID [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}', live.text()), live.text()[-800:]
live.until('Stopped')
live.press(stopped_menu, 'Add credential')
live.until('32-byte base64url secret')
second_secret = 'n' * 42 + 'o'
live.send(second_secret)
assert second_secret.encode() not in live.output
live.send('\r')
live.until('Add credential. Creates API key ID')
live.step()
live.send('y')
live.until('Credential added.')
assert re.search(r'API key ID [0-9a-f-]{36}', live.text()), live.text()[-800:]
live.press(stopped_menu, 'Diagnostics')
live.press(diagnostics_menu, 'Check installation')
live.until('Installation check passed.')
live.until('12 of 12 checks passed.')
live.press(diagnostics_menu, 'Back')
live.press(stopped_menu, 'Start Core')
core.prepare_start()
live.until('Start Core with saved settings')
live.step()
live.send('y')
live.until('Start completed.')
live.until('Running. Ready.')
live.menu(running_menu)
saved = read_json(root, 'setup', 'settings.json')
assert saved['effective'] == {'revision': '0', 'value': saved['saved']}
assert saved['saved'] == {**default_settings, 'host': '127.0.0.1', 'port': port, 'trustedOrigins': ['https://console.example']}

active = read_json(root, 'setup', 'tls-state.json')['active']['generation']
live.press(running_menu, 'Settings')
live.until('Last working revision 0')
live.menu(['Restart Core'] + page)
live.select(5)
live.until('Absolute certificate PEM path')
live.send(second[0] + '\r')
live.until('Absolute private key PEM path')
live.send(second[1] + '\r')
live.until('The running service keeps its loaded certificate until restart.')
live.step()
live.send('y')
live.until('Certificate saved. Not active until restart.')
live.until('Saved certificate is not active. Restart Core to apply.')
live.until('Running. Ready.')
assert 'stop' not in core.log().split(), 'saving a certificate must not restart Core'
assert read_json(root, 'setup', 'tls-state.json')['active']['generation'] == active
live.menu(['Restart Core'] + page)
live.select(6)
os.makedirs(os.path.join(root, 'data', 'logs'), exist_ok=True)
with open(os.path.join(root, 'data', 'logs', 'events.0.jsonl'), 'w') as file:
    file.write('not retained evidence\n')
exported = os.path.join(evidence, 'partial-export.jsonl')
live.press(running_menu, 'Diagnostics')
live.press(diagnostics_menu, 'Export diagnostics')
live.until('Absolute new diagnostic export path')
live.send(exported + '\r')
live.until('Export diagnostics to')
live.step()
live.send('y')
live.until('Partial export,')
live.until('Some diagnostics are missing.')
assert os.path.getsize(exported) > 0
core.release_failure = True
live.press(diagnostics_menu, 'Export diagnostics')
live.until('Absolute new diagnostic export path')
live.send(exported + '\r')
live.until('Export diagnostics to')
live.step()
live.send('y')
live.until('Operation failed. Committed effects may remain.')
live.until('Primary failure management_failed')
live.until('Cleanup failure maintenance_unavailable')
live.until('Failures management_failed, maintenance_unavailable')
live.until('Core did not answer.')
core.release_failure = False
live.press(diagnostics_menu, 'Back')

core.ready = False
live.press(running_menu, 'Refresh status')
live.until('Running. Not ready.')
core.ready = True
core.stop_delay = 0.8
live.press(running_menu, 'Stop Core')
live.until('Stop Core. Connections close and data is retained.')
live.step()
live.send('y')
assert core.stopping.wait(10), 'Stop must reach the service before Escape'
live.send('\x1b')
live.until('Cancellation arrived after the operation finished. Stopped. Writer exit verified.')
assert 'Cancelled before any change' not in live.text()
live.until('Stopped')
live.menu(stopped_menu)
assert live.alive(), 'Escape must return home after settlement'
core.prepare_start()
core.stop_delay = 0
live.select(0)
live.until('Start Core with saved settings')
live.step()
live.send('y')
live.until('Start completed.')
live.until('Running. Ready.')
live.menu(running_menu)
assert read_json(root, 'setup', 'tls-state.json')['active']['generation'] != active, 'Start activates the saved certificate'
live.finish(1)
assert secret.encode() not in live.output and second_secret.encode() not in live.output
assert secret not in core.log() and second_secret not in core.log()

os.unlink(os.path.join(root, 'control', 'maintenance.sock'))
blind = Terminal('readiness-unavailable', docker, existing=True, root=root)
blind.until('Running. Readiness unavailable.')
blind.menu(running_menu)
blind.finish(130)
write_json({'previous': None, 'next': read_json(root, 'setup', 'tls-state.json')['saved']}, root, 'setup', 'tls-journal.json')
journal = Terminal('certificate-recovery', docker, existing=True, root=root)
journal.until('Recovery required')
journal.until('Interrupted certificate save.')
journal.until(f'Stop Core, then run: atlas-core recover --installation {root}')
journal.menu(['Stop Core', 'Check installation', 'Refresh status', 'Exit'])
journal.finish(130)
core.close()
recovery_core.close()
print(json.dumps({'pty': 'pass', 'setup': 'guided, masked and cancelled before mutation', 'settings': 'plain edits preserve advanced values', 'lifecycle': 'contextual actions with retained failures', 'terminalLoss': 130, 'cancelledDoctorFailure': 1}))
