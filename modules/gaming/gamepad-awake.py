"""Keep a GNOME session awake while a gamepad is being played.

GNOME counts only keyboards, mice and touch as activity, so a game played on a
controller blanks and locks the screen after the idle delay, unless the game
asks GNOME not to, which games on Proton (Battle.net, WoW) do not. This watches
every gamepad (joystick evdev devices, which logind's uaccess lets the seat's
user read) and holds a GNOME idle inhibitor from a gamepad's first real input
until HOLD seconds after its last one. Then the idle delay applies again.

Noise does not count. Buttons and the d-pad count on press. An analog axis
(stick or trigger, whatever the layout) counts when it has moved an eighth of
its range from where it last counted, and a stick also while it is held far
over (holding forward to run).
"""

import selectors
import subprocess
import time

import evdev
from evdev import ecodes

HOLD = 300  # seconds of controller silence before the screen may blank again
RESCAN = 5  # seconds between looks for newly connected controllers

STICKS = {ecodes.ABS_X, ecodes.ABS_Y, ecodes.ABS_RX, ecodes.ABS_RY}
HATS = {ecodes.ABS_HAT0X, ecodes.ABS_HAT0Y}


def is_gamepad(dev):
    keys = dev.capabilities().get(ecodes.EV_KEY, [])
    return ecodes.BTN_GAMEPAD in keys or ecodes.BTN_JOYSTICK in keys


class Pad:
    def __init__(self, dev):
        self.dev = dev
        self.ranges = {}  # axis -> (min, max)
        self.anchors = {}  # axis -> the value where it last counted
        for code, info in dev.capabilities().get(ecodes.EV_ABS, []):
            self.ranges[code] = (info.min, info.max)
            self.anchors[code] = info.value

    def counts(self, event):
        if event.type == ecodes.EV_KEY:
            return event.value == 1
        if event.type != ecodes.EV_ABS or event.code not in self.ranges:
            return False
        if event.code in HATS:
            return event.value != 0
        low, high = self.ranges[event.code]
        span = high - low
        middle = (low + high) / 2
        if event.code in STICKS and abs(event.value - middle) > span * 3 / 8:
            return True
        if abs(event.value - self.anchors[event.code]) > span / 8:
            self.anchors[event.code] = event.value
            return True
        return False


class Inhibitor:
    """gnome-session-inhibit holds the inhibitor for as long as it runs."""

    def __init__(self):
        self.proc = None

    def hold(self):
        if self.proc is None or self.proc.poll() is not None:
            self.proc = subprocess.Popen([
                "gnome-session-inhibit", "--inhibit", "idle",
                "--app-id", "balaur-gamepad-awake",
                "--reason", "A gamepad is in use",
                "sleep", "infinity",
            ])
            print("gamepad in use: holding the screen awake", flush=True)

    def release(self):
        if self.proc is not None:
            self.proc.terminate()
            self.proc.wait()
            self.proc = None
            print("gamepad quiet: the idle delay applies again", flush=True)


def main():
    sel = selectors.DefaultSelector()
    open_paths = {}
    inhibitor = Inhibitor()
    last_input = 0.0
    next_scan = 0.0
    try:
        while True:
            now = time.monotonic()
            if now >= next_scan:
                next_scan = now + RESCAN
                for path in evdev.list_devices():
                    if path in open_paths:
                        continue
                    try:
                        dev = evdev.InputDevice(path)
                    except OSError:
                        continue
                    if is_gamepad(dev):
                        sel.register(dev, selectors.EVENT_READ, Pad(dev))
                        open_paths[path] = dev
                        print(f"watching {dev.name} ({path})", flush=True)
                    else:
                        dev.close()

            for key, _ in sel.select(timeout=RESCAN):
                dev = key.fileobj
                try:
                    events = list(dev.read())
                except OSError:  # disconnected
                    sel.unregister(dev)
                    dev.close()
                    open_paths.pop(dev.path, None)
                    print(f"{dev.name} is gone", flush=True)
                    continue
                if any(key.data.counts(e) for e in events):
                    last_input = time.monotonic()
                    inhibitor.hold()

            if inhibitor.proc and time.monotonic() - last_input > HOLD:
                inhibitor.release()
    finally:
        inhibitor.release()


if __name__ == "__main__":
    main()
