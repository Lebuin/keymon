# Run with: python3 -m unittest discover tests

import importlib.machinery
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAKES = os.path.join(ROOT, 'tests', 'fake_evdev')
HELPER = os.path.join(ROOT, 'helper', 'keymon-helper')

sys.path.insert(0, FAKES)
import evdev  # noqa: E402

loader = importlib.machinery.SourceFileLoader('keymon_helper', HELPER)
spec = importlib.util.spec_from_loader('keymon_helper', loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)

KEY_A, KEY_S, BTN_LEFT, BTN_DPAD_UP = 30, 31, 0x110, 0x220
EV_SYN = evdev.ecodes.EV_SYN
REPORT = evdev.event(EV_SYN, evdev.ecodes.SYN_REPORT, 0)
DROPPED = evdev.event(EV_SYN, evdev.ecodes.SYN_DROPPED, 0)


class KeyboardTest(unittest.TestCase):
    def setUp(self):
        self.fake = evdev.FakeDevice([KEY_A, KEY_S])
        evdev.devices['k'] = self.fake
        self.keyboard = helper.Keyboard(evdev.InputDevice('k'))

    def tearDown(self):
        evdev.devices.clear()

    def test_press_and_release(self):
        self.assertEqual(self.keyboard.process([evdev.key(KEY_A, 1), REPORT, evdev.key(KEY_A, 0)]),
                         [(KEY_A, True), (KEY_A, False)])

    def test_ignores_repeat(self):
        self.assertEqual(self.keyboard.process([evdev.key(KEY_A, 2)]), [])

    def test_ignores_buttons(self):
        self.assertEqual(self.keyboard.process([evdev.key(BTN_LEFT, 1), evdev.key(BTN_DPAD_UP, 1)]), [])

    def test_ignores_other_event_types(self):
        self.assertEqual(self.keyboard.process([evdev.event(evdev.ecodes.EV_REL, 0, 1)]), [])

    def test_syn_dropped_emits_differences(self):
        self.keyboard.process([evdev.key(KEY_A, 1)])
        self.fake.active = [KEY_S, BTN_LEFT]
        changes = self.keyboard.process([DROPPED, evdev.key(KEY_A, 0), REPORT])
        self.assertEqual(changes, [(KEY_A, False), (KEY_S, True)])
        self.assertEqual(self.keyboard.held, {KEY_S})

    def test_syn_dropped_waits_for_report(self):
        self.assertEqual(self.keyboard.process([DROPPED, evdev.key(KEY_A, 1)]), [])
        self.fake.active = [KEY_A]
        self.assertEqual(self.keyboard.process([REPORT]), [(KEY_A, True)])

    def test_release_all(self):
        self.keyboard.process([evdev.key(KEY_S, 1), evdev.key(KEY_A, 1)])
        self.assertEqual(self.keyboard.release_all(), [(KEY_A, False), (KEY_S, False)])
        self.assertEqual(self.keyboard.release_all(), [])


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.original_rescan = helper.RESCAN_SECONDS
        helper.RESCAN_SECONDS = 0.02
        self.dir = tempfile.TemporaryDirectory()
        self.original_glob = helper.DEVICE_GLOB
        helper.DEVICE_GLOB = os.path.join(self.dir.name, 'event*')
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(os.path.join(self.dir.name, 'keys.sock'))
        self.listener.listen()
        self.ours, theirs = socket.socketpair()
        self.ours.settimeout(2)
        self.reader = self.ours.makefile()
        self.listener.setblocking(False)
        self.instance = helper.Helper(self.listener, theirs)

    def tearDown(self):
        helper.RESCAN_SECONDS = self.original_rescan
        helper.DEVICE_GLOB = self.original_glob
        self.reader.close()
        self.ours.close()
        if self.thread.is_alive():
            raise AssertionError('helper did not exit')
        self.listener.close()
        self.dir.cleanup()
        evdev.devices.clear()

    def add(self, name, codes):
        path = os.path.join(self.dir.name, f'event-{name}')
        open(path, 'w').close()
        evdev.devices[path] = evdev.FakeDevice(codes)
        return evdev.devices[path]

    def start(self):
        self.thread = threading.Thread(target=self.instance.run)
        self.thread.start()

    def stop(self):
        self.ours.shutdown(socket.SHUT_RDWR)
        self.thread.join(2)

    def line(self):
        return json.loads(self.reader.readline())

    def wait_until(self, condition):
        deadline = time.monotonic() + 2
        while not condition():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)

    def test_forwards_protocol_lines(self):
        keyboard = self.add('kbd', [KEY_A])
        self.start()
        self.wait_until(lambda: keyboard.opened)
        keyboard.push(evdev.key(KEY_A, 1), evdev.key(KEY_A, 2), evdev.key(KEY_A, 0))
        self.assertEqual(self.line(), {'code': KEY_A, 'down': True})
        self.assertEqual(self.line(), {'code': KEY_A, 'down': False})
        self.stop()

    def test_exit_closes_devices(self):
        keyboard = self.add('kbd', [KEY_A])
        self.start()
        self.wait_until(lambda: keyboard.opened)
        self.stop()
        self.assertEqual(keyboard.closed, 1)

    def test_skips_devices_with_only_buttons(self):
        mouse = self.add('mouse', [BTN_LEFT])
        self.start()
        self.wait_until(lambda: mouse.closed)
        time.sleep(0.1)  # Several rescans, which must not reopen it.
        self.assertEqual(mouse.opened, 1)
        self.stop()

    def test_picks_up_added_device(self):
        self.start()
        keyboard = self.add('late', [KEY_S])
        self.wait_until(lambda: keyboard.opened)
        keyboard.push(evdev.key(KEY_S, 1))
        self.assertEqual(self.line(), {'code': KEY_S, 'down': True})
        self.stop()

    def test_removed_device_releases_held_keys(self):
        keyboard = self.add('kbd', [KEY_A])
        self.start()
        self.wait_until(lambda: keyboard.opened)
        keyboard.push(evdev.key(KEY_A, 1))
        self.line()
        keyboard.vanish()
        self.assertEqual(self.line(), {'code': KEY_A, 'down': False})
        self.wait_until(lambda: keyboard.closed)
        self.stop()

    def test_turns_away_a_second_client(self):
        self.start()
        second = socket.socket(socket.AF_UNIX)
        second.settimeout(2)
        second.connect(self.listener.getsockname())
        self.assertEqual(second.recv(1), b'')
        second.close()
        self.stop()


class ActivationTest(unittest.TestCase):
    def test_serves_one_client_then_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'keys.sock')
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(path)
            listener.listen()
            client = socket.socket(socket.AF_UNIX)
            client.connect(path)
            os.set_inheritable(listener.fileno(), True)
            fd = listener.fileno()

            def as_fd_3():
                os.dup2(fd, helper.LISTEN_FD)

            process = subprocess.Popen(
                [sys.executable, HELPER],
                env={'LISTEN_FDS': '1', 'PYTHONPATH': FAKES},
                pass_fds=(fd,), preexec_fn=as_fd_3, stderr=subprocess.DEVNULL)
            try:
                time.sleep(0.2)
                self.assertIsNone(process.poll())
                client.close()
                self.assertEqual(process.wait(5), 0)
            finally:
                process.kill()
                process.wait()
                listener.close()

    def test_refuses_to_run_without_socket(self):
        result = subprocess.run(
            [sys.executable, HELPER], env={'PYTHONPATH': FAKES}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
