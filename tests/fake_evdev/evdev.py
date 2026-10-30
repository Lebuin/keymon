# Stands in for python-evdev in tests, so they need no input devices or package.

import errno
import os
from types import SimpleNamespace

ecodes = SimpleNamespace(EV_SYN=0, EV_KEY=1, EV_REL=2, SYN_REPORT=0, SYN_DROPPED=3)

devices = {}


def event(type_, code, value):
    return SimpleNamespace(type=type_, code=code, value=value)


def key(code, value):
    return event(ecodes.EV_KEY, code, value)


class FakeDevice:
    def __init__(self, codes):
        self.codes = codes
        self.pending = []
        self.active = []
        self.gone = False
        self.opened = 0
        self.closed = 0
        self.read_fd, self.write_fd = os.pipe()

    def push(self, *events):
        self.pending += events
        os.write(self.write_fd, b'x')

    def vanish(self):
        self.gone = True
        os.write(self.write_fd, b'x')


class InputDevice:
    def __init__(self, path):
        # The activation test runs against the real /dev/input listing, and must
        # never open anything from it.
        if path not in devices:
            raise OSError(errno.EACCES, 'Not a fake device')
        self.fake = devices[path]
        self.fake.opened += 1

    def fileno(self):
        return self.fake.read_fd

    def capabilities(self, absinfo=True):
        return {ecodes.EV_KEY: self.fake.codes}

    def active_keys(self):
        return self.fake.active

    def read(self):
        os.read(self.fake.read_fd, 4096)
        if self.fake.gone:
            raise OSError(errno.ENODEV, 'No such device')
        events, self.fake.pending = self.fake.pending, []
        return iter(events)

    def close(self):
        self.fake.closed += 1
