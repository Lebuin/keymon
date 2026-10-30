#!/usr/bin/env python3
"""Measures how fast an application really receives a held key's repeats.

Run it in a terminal and hold a letter key for several seconds, then let go. It
prints the delay and interval it saw next to GNOME's settings. The difference is
what REPEAT_LAG_MS in extension/extension.js and keys.repeat_interval_ms make up.
Ctrl+C quits without a result.
"""

import os
import select
import statistics
import subprocess
import sys
import termios
import time
import tty

# A pause this long means the key was released. It is well above any repeat delay.
RELEASE_GAP_S = 1.5
MIN_REPEATS = 10
CTRL_C = 3


def read_times(fd):
    """Returns the arrival time of each byte, up to the pause after the key is let go."""
    times = []
    while True:
        ready, _, _ = select.select([fd], [], [], RELEASE_GAP_S if times else None)
        if not ready:
            return times
        data = os.read(fd, 1024)
        arrived = time.monotonic()
        if not data or CTRL_C in data:
            return None
        times.extend([arrived] * len(data))


def measure(times):
    """Returns (delay, mean interval, median interval, repeats), in milliseconds.

    The mean is what decides whether a display keeps pace over a long hold, so it
    is taken across the whole hold, which single late arrivals barely move.
    """
    gaps = [(b - a) * 1000 for a, b in zip(times[1:], times[2:])]
    mean = (times[-1] - times[1]) * 1000 / len(gaps)
    return (times[1] - times[0]) * 1000, mean, statistics.median(gaps), len(gaps)


def gnome_setting(key):
    """Returns a value from GNOME's keyboard settings, or None without gsettings."""
    try:
        output = subprocess.run(
            ["gsettings", "get", "org.gnome.desktop.peripherals.keyboard", key],
            capture_output=True, text=True, check=True).stdout
        return int(output.split()[-1])
    except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
        return None


def main():
    fd = sys.stdin.fileno()
    if not os.isatty(fd):
        sys.exit("Run this in a terminal, so that it can read the keyboard.")

    print("Hold a letter key for at least 5 seconds, then let go. Ctrl+C quits.")
    saved = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        termios.tcsetattr(fd, termios.TCSANOW, _without_echo(fd))
        times = read_times(fd)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)

    if times is None:
        return
    if len(times) < MIN_REPEATS + 2:
        sys.exit(f"Only {len(times)} characters arrived. Hold the key for longer.")

    delay, mean, median, repeats = measure(times)
    setting_delay = gnome_setting("delay")
    setting_interval = gnome_setting("repeat-interval")
    print(f"Repeats:  {repeats}")
    print(f"Delay:    {delay:.2f} ms (GNOME setting: {setting_delay} ms)")
    print(f"Interval: {mean:.2f} ms mean, {median:.2f} ms median (GNOME setting: {setting_interval} ms)")
    if setting_interval is not None:
        print(f"Lag:      {mean - setting_interval:.2f} ms")


def _without_echo(fd):
    attributes = termios.tcgetattr(fd)
    attributes[3] &= ~termios.ECHO
    return attributes


if __name__ == "__main__":
    main()
