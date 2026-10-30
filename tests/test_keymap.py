#!/usr/bin/python3
"""Run with: python3 tests/test_keymap.py"""

import json
import pathlib
import subprocess
import unittest

TOOL = pathlib.Path(__file__).resolve().parent.parent / "extension" / "keymon-keymap"

SHIFT, ALTGR, CAPS, NUM = 1, 2, 4, 8
# XKB keycodes: evdev code + 8.
ONE, A, APOSTROPHE, TAB, ENTER, SPACE, CAPS_KEY, KP1, F5, RALT, LEFT_ALT = 10, 38, 48, 23, 36, 65, 66, 87, 71, 108, 64


def table(layout, variant="", options=""):
    result = subprocess.run(
        [TOOL, "--layout", layout, "--variant", variant, "--options", options],
        capture_output=True, check=True, text=True)
    return json.loads(result.stdout)["keys"]


class Us(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = table("us", "altgr-intl")

    def entry(self, keycode, bits=0):
        return self.keys[str(keycode)][bits]

    def test_every_key_has_all_combinations(self):
        for entries in self.keys.values():
            self.assertEqual(len(entries), 16)

    def test_shift_resolves_the_character(self):
        self.assertEqual(self.entry(ONE)["text"], "1")
        self.assertEqual(self.entry(ONE, SHIFT)["text"], "!")
        self.assertEqual(self.entry(ONE, SHIFT)["class"], "printable")

    def test_caps_lock_uppercases_letters(self):
        self.assertEqual(self.entry(A)["text"], "a")
        self.assertEqual(self.entry(A, CAPS)["text"], "A")
        self.assertEqual(self.entry(A, CAPS | SHIFT)["text"], "a")

    def test_num_lock_selects_keypad_digits(self):
        self.assertEqual(self.entry(KP1, NUM), {"keysym": "KP_1", "text": "1", "class": "printable"})
        self.assertEqual(self.entry(KP1), {"keysym": "KP_End", "text": None, "class": "special"})

    def test_dead_keys_show_their_spacing_character(self):
        self.assertEqual(self.entry(APOSTROPHE)["text"], "'")
        self.assertEqual(
            self.entry(APOSTROPHE, ALTGR),
            {"keysym": "dead_acute", "text": "´", "class": "printable"})

    def test_keys_with_control_characters_are_special(self):
        self.assertEqual(self.entry(ENTER), {"keysym": "Return", "text": None, "class": "special"})
        self.assertEqual(self.entry(TAB, SHIFT)["keysym"], "ISO_Left_Tab")
        self.assertEqual(self.entry(F5), {"keysym": "F5", "text": None, "class": "special"})

    def test_space_is_printable(self):
        self.assertEqual(self.entry(SPACE), {"keysym": "space", "text": " ", "class": "printable"})

    def test_modifiers_are_classified_from_the_keysym(self):
        self.assertEqual(self.entry(RALT), {"keysym": "ISO_Level3_Shift", "text": None, "class": "modifier"})
        self.assertEqual(self.entry(LEFT_ALT)["class"], "modifier")
        self.assertEqual(self.entry(CAPS_KEY), {"keysym": "Caps_Lock", "text": None, "class": "special"})


class OtherLayouts(unittest.TestCase):
    def test_be_gives_the_same_physical_key_other_characters(self):
        keys = table("be")
        self.assertEqual(keys[str(ONE)][0]["text"], "&")
        self.assertEqual(keys[str(ONE)][SHIFT]["text"], "1")
        self.assertEqual(keys[str(ONE)][ALTGR]["text"], "|")

    def test_options_remap_keys(self):
        keys = table("us", options="ctrl:nocaps")
        self.assertEqual(keys[str(CAPS_KEY)][0], {"keysym": "Control_L", "text": None, "class": "modifier"})

    def test_an_unknown_layout_fails(self):
        result = subprocess.run(
            [TOOL, "--layout", "not-a-layout"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not-a-layout", result.stderr)


if __name__ == "__main__":
    unittest.main()
