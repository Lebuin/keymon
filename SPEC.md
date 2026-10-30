# keymon: specification

keymon shows keystrokes and mouse activity on screen for screencasts. It runs on one personal machine.

## 1. Target environment

| Item | Value |
|---|---|
| OS | Ubuntu 24.04 |
| Desktop | GNOME Shell 46, Wayland session |
| Monitors | Two: `eDP-1` and `DP-1`, currently at scale 1.0 |
| Keyboard layouts | `us+altgr-intl` and `be`, switchable at runtime |

## 2. Goals

- Show held and recently pressed keys in a plain overlay.
- Merge plain typing into readable text.
- Highlight the pointer with a permanent ring, and show a ripple on each mouse press.
- Make appearance and timing configurable through one file.
- Read keyboard input only while the tool is switched on.
- Appear in screen recordings made with GNOME's recorder and with OBS.

## 3. Out of scope for v1

- Other desktops, X11, other GNOME versions, packaging, and publishing on extensions.gnome.org.
- Key-cap styling, icons, sounds, themes, and per-app rules.
- Starting, stopping, or detecting recorders. The user toggles keymon by hand.
- Mouse gesture recognition, touchpad multi-finger gestures, and scroll indicators.
- A settings GUI.
- A pause hotkey or a "combos only" mode (see §10).

## 4. Architecture

Wayland and Mutter impose this design. Mutter has no layer-shell, so a normal app cannot reliably draw an always-on-top, click-through window. Normal apps also cannot read the global pointer position. An extension can do both, but it cannot reliably see keys while another app has focus, so keys come from `/dev/input` through a separate helper.

```
/dev/input/event*                         ~/.config/keymon/config.json
      │ read-only                                     │ watched
      ▼                                               ▼
keymon-helper  ── JSON lines over Unix socket ──▶ GNOME Shell extension
(Python, systemd, socket-activated)               ├─ display state machine
                                                  ├─ key overlay actors
keymon-keymap  ── keymap table as JSON ─────────▶ ├─ pointer ring and ripples
(Python, unprivileged, run on demand)             └─ panel toggle and shortcut
```

| Component | Language | Privileges | Responsibility |
|---|---|---|---|
| Extension | GJS | User, inside GNOME Shell | Everything visible, pointer tracking, config, on/off state |
| `keymon-helper` | Python 3, `python3-evdev` | `input` group only | Forwards raw key press and release events |
| `keymon-keymap` | Python 3, `ctypes` with libxkbcommon | User | Converts a layout into a lookup table |

Key labels are resolved in the extension, so the privileged helper needs no layout knowledge.

## 5. Keyboard helper

### Activation

- systemd socket activation starts the helper. `keymon.socket` listens on `/run/keymon/keys.sock`, owned by the user, mode `0600`.
- The extension connects when switched on, which starts `keymon.service`. The helper exits when that client disconnects.
- No password is needed at toggle time, and no keyboard device is open while keymon is off.
- The helper accepts one client at a time.

### Service hardening

`keymon.service` must use at least: `DynamicUser=yes`, `SupplementaryGroups=input`, `NoNewPrivileges=yes`, `PrivateNetwork=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `DevicePolicy=closed`, and `DeviceAllow=char-input r`.

The user is not added to the `input` group. The helper writes no key data to logs or disk.

### Behaviour

- It opens every `/dev/input/event*` device that reports at least one non-button key.
- It rescans every 2 seconds to pick up added and removed devices.
- It forwards key codes only. It ignores button codes (mouse input comes from the extension) and auto-repeat events (value 2).
- It handles `SYN_DROPPED` by comparing against the device's current key state and emitting the differences.
- When a device disappears, it emits a release for each key still held on that device.
- It does not grab devices, so input still reaches applications normally.

### Protocol

One JSON object per line, from helper to extension only:

```json
{"code": 30, "down": true}
```

`code` is the evdev key code. The XKB keycode is `code + 8`.

## 6. Key label resolution

The extension gets the active layout, variant, and XKB options from GNOME's input source manager. It runs `keymon-keymap`, passes those values, and caches the resulting table per layout for the session.

The table maps each keycode, for all 16 combinations of Shift, AltGr, Caps Lock, and Num Lock, to:

- the keysym name
- the UTF-8 text, if any
- a class: `modifier`, `printable`, or `special`

The classification comes from the keysym, so XKB remapping is respected. For example, Caps remapped to Ctrl displays as Ctrl.

### Label rules

- **Resolved characters:** labels show what the key produces. Shift+1 shows `!` on `us`.
- **Locked at press:** the label is set when the key goes down and does not change while held. Press 1 then Shift: the box still says `1`. Release matches by key code.
- **Combos:** Ctrl+C shows `Ctrl` and `c`. Letters are not force-uppercased. Ctrl+Shift+T shows `Ctrl`, `Shift`, `T`.
- **Layout switch:** applies to the next key press. Labels already shown stay as they are.
- **Dead keys:** shown as their spacing character, with no composition. `'` then `e` on `altgr-intl` shows `´e`, not `é`. This is a known v1 limitation.
- **Left and right variants:** share one label and one box, reference-counted across keys and keyboards.

### Default names

Names can be overridden through `keys.names` in config. Keysyms with no entry show their keysym name.

| Key | Label | Key | Label |
|---|---|---|---|
| Control | `Ctrl` | Enter, keypad Enter | `Enter` |
| Shift | `Shift` | Escape | `Esc` |
| Alt | `Alt` | Tab | `Tab` |
| AltGr (`ISO_Level3_Shift`) | `AltGr` | Backspace | `Backspace` |
| Super | `Super` | Delete | `Del` |
| Arrows | `←` `↑` `→` `↓` | Function keys | `F1` … `F24` |
| Page Up / Down | `PgUp` `PgDn` | Caps Lock | `Caps` |
| Home / End / Insert | `Home` `End` `Ins` | Space, in a box | `Space` |

## 7. Key display behaviour

The overlay is a horizontal row of separate boxes, each a rectangle with a translucent dark background and white text.

### Box types

| Type | Created by | Goes away |
|---|---|---|
| Modifier box | Ctrl, Alt, AltGr, Shift, Super | Minimum duration rule |
| Key box | Special keys, and printable keys in a combo | Minimum duration rule |
| Text run | Printable keys with no Ctrl, Alt, or Super held | Idle timeout rule |

### Minimum duration rule

A box stays visible until `max(release time, press time + keys.min_duration_ms)`. Pressing the same key again while its box is visible reuses the box and restarts its timer.

### Order

1. Modifier boxes come first, always in the order Ctrl, Alt, AltGr, Shift, Super.
2. Text runs and key boxes follow, in order of creation.

Boxes close gaps immediately when one is removed.

### Text runs

- A printable key is any key with visible text, including Space and keypad digits. It joins a run when Ctrl, Alt, and Super are not physically held.
- Run text is built from each key's locked label. Space appears as `keys.space_symbol` so that trailing spaces stay visible.
- Auto-repeat is ignored. Holding `a` shows one `a`.
- Keys held at the same time merge. Holding A and S shows one box, `as`, not two. This is a deliberate exception to separate boxes for held keys.
- Only the last `keys.run_max_chars` characters are shown, with a leading `…` when text has been cut.
- A run clears `keys.run_idle_ms` after its most recent key was released. It does not clear while any of its keys is held.

### Special keys end a run

Any special key (such as Enter, Tab, Backspace, an arrow, Esc, or a function key) ends the current run. The ended run stays until its idle timeout, and the special key gets its own box to the right. The next printable key starts a new run after that box.

Typing `hello`, Enter, `world` shows `hello` `Enter` `world`. Backspace does not delete characters from a run, so corrections stay visible to viewers.

### Combos replace runs

When a printable or special key is pressed with Ctrl, Alt, or Super physically held, all runs clear immediately. The modifiers and the key then display as separate boxes under the minimum duration rule.

A modifier box that is only lingering does not create a combo. Only physically held keys count.

### Shift and AltGr while typing

These are absorbed into typed text, so that writing a capital does not flash a `Shift` box:

- When Ctrl, Alt, and Super are not held and no other non-modifier key is held, a Shift or AltGr box appears only after `keys.modifier_delay_ms`.
- If a printable key is pressed within that delay, no box appears for that hold.
- If a printable key is pressed after the box appeared, the box is removed.
- With a special key, as in Shift+Tab, the box appears immediately and stays under the minimum duration rule.
- Ctrl, Alt, and Super boxes always appear immediately, as does Shift in Ctrl+Shift+T.

### Limits

- The row holds at most `keys.max_boxes` boxes and must fit the target monitor. There is no wrapping.
- When a limit is exceeded, the oldest box whose keys are no longer held is removed first. Boxes with held keys are never removed.
- If held keys alone exceed the limit, the row is allowed to overflow.

### Stale state

- A release with no matching press is ignored. This covers a toggle shortcut still held when keymon switches on.
- When the helper disconnects, all held-key state and all boxes clear.

## 8. Mouse display behaviour

- While active, the extension reads `global.get_pointer()` once per frame for position and button state, using a `Clutter.Timeline` on the ring so it follows the frame clock of the monitor the ring is on.
- Left, middle, and right buttons are tracked. Touchpad tap-to-click counts, because polling sees the compositor's logical buttons.
- Back, forward, and other side buttons are ignored.

### Permanent ring

- A circle centred on the pointer, with a configurable radius, stroke width, stroke colour, and fill colour (transparent by default).
- It moves across both monitors, and is hidden only when keymon is off.
- It stays visible when an app hides the cursor.

### Held state

While any tracked button is held, the ring uses `mouse.held_stroke_width` and the colour of the most recently pressed held button. It reverts instantly on release.

### Click ripple

- On every press transition, a ripple starts at the pointer's position at that moment and stays there if the pointer moves.
- Its radius goes from 0 to the permanent ring's radius while its opacity goes from `mouse.ripple.start_opacity` to 0, over `mouse.ripple.duration_ms`, with ease-out easing by default.
- Each button has its own colour, and all default to one value.
- Ripples overlap independently. A new click does not cancel an earlier ripple.
- There is no ripple on release.

A press and release that both fall between two frames is missed. At 60 Hz this needs a click shorter than about 17 ms, which is accepted.

## 9. Placement and rendering

- All actors belong to GNOME Shell's top chrome, above windows and panels, including fullscreen windows.
- All actors are non-reactive, so clicks pass through and the overlay never takes focus.
- While keymon is on, the extension calls `Meta.disable_unredirect_for_display()`, so that direct scanout of a fullscreen window cannot bypass the actors. It re-enables this when switched off.
- Sizes and offsets are in logical pixels.

### Key overlay placement

- The key row is shown only on `overlay.monitor`: `"primary"` or a connector name such as `"DP-1"`.
- If the named monitor is absent, it falls back to primary. It repositions when monitors change.
- `overlay.anchor_h` and `overlay.anchor_v` select both the reference point on the monitor and the matching point on the row. `bottom` + `center` puts the row's bottom-centre at the monitor's bottom-centre.
- `overlay.offset_x` and `offset_y` shift the row from that point. Positive values always move right and down.
- The row grows away from its anchor: to the right when `left`, to the left when `right`, and in both directions when `center`.

## 10. Lifecycle and privacy

### On/off

- keymon is off after login. The extension is loaded but idle: no helper connection, no pointer tracking, no actors.
- The panel icon and a global shortcut (`toggle_shortcut`) switch it on and off.
- Switching off closes the helper connection, stops pointer tracking, and removes all actors immediately.
- The panel icon shows three states: off, on, and error.

### Lock screen

- The extension runs only in the `user` session mode, so GNOME disables it when the screen locks. The helper connection closes, and no unlock-screen keys are read or shown.
- After unlocking, keymon returns to its state before locking. That state is held in memory only, so a new login always starts off.
- Key events arriving while the session is inactive, such as after a switch to another virtual terminal, are discarded.

### Accepted risk

Everything typed in a normal session is shown while keymon is on, including passwords. There is no automatic detection of password fields. The user switches keymon off before typing secrets, or edits the recording afterwards.

## 11. Configuration

The file is `~/.config/keymon/config.json`. JSON is used because GJS can parse it with no dependency.

- Missing file: all defaults are used, and the file is not created automatically. The repo ships a complete `config.example.json`.
- Missing keys take their default, and unknown keys are ignored.
- The file is watched and changes apply live, without a restart.
- Invalid JSON or an invalid value: the last valid config stays active for the whole file, and a GNOME notification names the problem.
- Colours are CSS strings such as `#ffffff` or `rgba(0,0,0,0.75)`.

| Key | Default | Meaning |
|---|---|---|
| `toggle_shortcut` | `"<Super><Alt>k"` | Global on/off shortcut, applied through the extension's GSettings key |
| `overlay.monitor` | `"primary"` | `"primary"` or a connector name |
| `overlay.anchor_h` | `"center"` | `left`, `center`, or `right` |
| `overlay.anchor_v` | `"bottom"` | `top`, `center`, or `bottom` |
| `overlay.offset_x` | `0` | Horizontal shift in px |
| `overlay.offset_y` | `-80` | Vertical shift in px |
| `overlay.box_spacing` | `8` | Gap between boxes in px |
| `box.background` | `"rgba(0,0,0,0.75)"` | Box background |
| `box.padding_h` | `16` | Horizontal padding in px |
| `box.padding_v` | `8` | Vertical padding in px |
| `box.corner_radius` | `4` | Corner radius in px |
| `text.color` | `"#ffffff"` | Text colour |
| `text.size` | `28` | Text size in px |
| `text.font` | `"sans"` | Font family |
| `keys.min_duration_ms` | `300` | Minimum time a key box is shown |
| `keys.run_idle_ms` | `1500` | Time before a text run clears |
| `keys.run_max_chars` | `30` | Visible characters in a run |
| `keys.modifier_delay_ms` | `120` | Delay before a lone Shift or AltGr box |
| `keys.max_boxes` | `12` | Maximum boxes in the row |
| `keys.space_symbol` | `"␣"` | Space inside a run |
| `keys.names` | `{}` | Keysym name to label overrides |
| `mouse.ring.radius` | `28` | Permanent ring and final ripple radius in px |
| `mouse.ring.stroke_width` | `3` | Ring stroke in px |
| `mouse.ring.stroke_color` | `"#ffcc00"` | Ring colour with no button held |
| `mouse.ring.fill_color` | `"rgba(0,0,0,0)"` | Ring fill |
| `mouse.held_stroke_width` | `5` | Ring stroke while a button is held |
| `mouse.colors.left` | `"#ffcc00"` | Left button ripple and held colour |
| `mouse.colors.middle` | `"#ffcc00"` | Middle button ripple and held colour |
| `mouse.colors.right` | `"#ffcc00"` | Right button ripple and held colour |
| `mouse.ripple.duration_ms` | `300` | Ripple duration |
| `mouse.ripple.start_opacity` | `0.8` | Opacity at the start of a ripple |
| `mouse.ripple.easing` | `"ease-out"` | `linear`, `ease-in`, `ease-out`, or `ease-in-out` |

## 12. Error handling

| Situation | Behaviour |
|---|---|
| Socket or service is missing | Mouse display still works, panel icon shows error, and one notification explains how to run the installer |
| Helper disconnects while on | Boxes clear, then reconnect with backoff of 1, 2, 4, up to 30 s, with the icon in error until reconnected |
| No keyboard device found | Helper stays connected and keeps rescanning |
| `keymon-keymap` fails, or layout is unknown | Falls back to `us`, with one notification |
| Keycode has no table entry | Box shows `Key<code>` |
| Monitor added or removed | Row repositions with no restart |
| Exception in the extension | Logged to the journal under a `keymon` prefix, and keymon switches off rather than leaving stale overlays |

## 13. Installation

`install.sh` in the repo:

1. Checks for GNOME Shell 46 and a Wayland session.
2. Installs `python3-evdev` with apt.
3. Installs the helper to `/usr/local/lib/keymon/`, installs the systemd units, and enables `keymon.socket`. Steps 2 and 3 use sudo.
4. Installs the extension to `~/.local/share/gnome-shell/extensions/keymon@local/`, with `keymon-keymap`, and compiles its GSettings schema.
5. Tells the user to log out and in, because Wayland GNOME Shell cannot load a new extension without that.

If the extension path is already a symlink to this repo, as `dev/link-extension.sh` makes it, step 4 keeps the link and only compiles the schema. A symlink to anywhere else stops the installer before it changes anything.

`uninstall.sh` reverses all of these steps. It leaves the config file in place.

### Proposed repo layout

```
SPEC.md
install.sh, uninstall.sh
config.example.json
extension/      metadata.json, extension.js, state.js, overlay.js, pointer.js, schemas/
helper/         keymon-helper, keymon.service, keymon.socket
keymap/         keymon-keymap
tests/
```

`state.js` holds the display state machine from §7. It must have no Shell imports, and takes events and a clock as inputs, so that it can be tested under plain `gjs`.

## 14. Acceptance criteria

**Keys**

1. Holding Ctrl and Shift with another app focused shows two boxes side by side, in that order.
2. A very short tap stays visible for `keys.min_duration_ms`.
3. Typing `hello` shows one box, `hello`, which clears 1.5 s after the last release.
4. `hello`, Enter, `world` shows three boxes.
5. Ctrl+C during a run clears the run and shows `Ctrl` and `c`.
6. Typing a capital letter shows no `Shift` box. Holding Shift alone shows one after 120 ms.
7. Shift+1 shows `!` on `us`. The same physical key shows the correct character after switching to `be`.
8. Holding a key shows one character, with no repeats.
9. Holding 1 then pressing Shift leaves the label as `1`.

**Mouse**

10. The ring follows the pointer across both monitors, with no visible offset at scale 1.0.
11. Every left, middle, and right press gives one ripple from radius 0 to ring radius, fading out, in that button's colour.
12. Rapid clicks produce overlapping ripples.
13. The ring changes while dragging and reverts on release.

**System**

14. The overlay never blocks clicks or takes focus, including above fullscreen windows.
15. Every anchor combination places the row correctly on the configured monitor.
16. A config edit applies live. A broken config keeps the last valid one and shows a notification.
17. While off, `systemctl status keymon.service` shows inactive, and no process has an input device open for keymon.
18. Locking the screen removes the overlay. Keys typed to unlock are not shown, and keymon resumes after unlock.
19. The user's account is not in the `input` group after installation.
20. The overlay and ring appear in recordings from GNOME's recorder and OBS.

## 15. Implementation risks

Items 1–3 were checked with the stage 1 prototype on the target machine.

1. **Capture in OBS:** confirmed. The ring and box appear in GNOME's recorder and in OBS, and the ring lines up with the cursor.
2. **GNOME API details:** confirmed on GNOME 46.
   - `global.backend.get_monitor_manager().get_monitor_for_connector(name)` returns the monitor index, or -1 for an unknown name. `Main.layoutManager.monitors` entries have no connector field.
   - A keybinding works from a config value by writing it to the GSettings key and then calling `Main.wm.addKeybinding`.
   - `getInputSourceManager().currentSource.xkbId` gives `layout+variant`, and `current-source-changed` fires on a switch. Options come from the `xkb-options` key of `org.gnome.desktop.input-sources`.
3. **Pointer smoothness:** the frame clock looked better than a 60 Hz timer, so §8 uses it and `mouse.poll_hz` is gone.
4. **GNOME upgrades:** `metadata.json` declares only `"46"`. A later Ubuntu release will probably need porting work, and this is accepted.
