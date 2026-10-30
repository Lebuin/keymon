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
- **Locked at press:** the label is set when the key goes down and does not change while held. Press 1 then Shift: the run still says `1`. Release matches by key code.
- **Combos:** Ctrl+C shows `Ctrl` and `c`. Letters are not force-uppercased. Ctrl+Shift+T shows `Ctrl`, `Shift`, `T`.
- **Layout switch:** applies to the next key press. Labels already shown stay as they are.
- **Dead keys:** shown as their spacing character, with no composition. AltGr+`'` then `e` on `altgr-intl` shows `´e`, not `é`. This is a known v1 limitation.
- **Left and right variants:** share one label and one box, reference-counted across keys and keyboards.

### Default names

These labels apply in modifier runs and, in angle quotes, as tokens in text runs (see §7). Symbols are never quoted. Names can be overridden through `keys.names` in config. Keysyms with no entry show their keysym name.

| Key | Label | Key | Label |
|---|---|---|---|
| Control | `Ctrl` | Enter, keypad Enter | `⏎` |
| Shift | `Shift` | Escape | `Esc` |
| Alt | `Alt` | Tab | `⇥` |
| AltGr (`ISO_Level3_Shift`) | `AltGr` | Backspace | `⌫` |
| Super | `Super` | Delete | `Del` |
| Arrows | `←` `↑` `→` `↓` | Function keys | `F1` … `F24` |
| Page Up / Down | `PgUp` `PgDn` | Caps Lock | `Caps` |
| Home / End / Insert | `Home` `End` `Ins` | Space | `keys.space_symbol` |

## 7. Key display behaviour

The overlay is a vertical stack of 0, 1, or more runs. Each run is one row. There are two kinds:

| Kind | Contents | Appearance |
|---|---|---|
| Text run | Typed characters and inline special keys | One box holding all the text |
| Modifier run | Modifiers, plus at most one other key | One box with the parts joined by `+`, modifiers first, always in the order Ctrl, Alt, AltGr, Shift, Super |

Each box has a translucent dark background and white text. The examples below write the parts of a modifier run separately: `Ctrl` `c` displays as `Ctrl+c`.

In a text run, special keys and the space symbol use `text.muted_color`, so typed text stands out from them. Everything in a modifier run uses it too, including the `+`. Held keys use `text.held_color` instead, where one is set.

### Modifier classes

- **Hard modifiers:** Ctrl, Alt, and Super. They always act as modifiers and show immediately.
- **Soft modifiers:** Shift and AltGr. They only act as modifiers under the rules in "Shift and AltGr" below, because they also produce characters.

A key is **chorded** when a hard modifier is physically held, or when a soft modifier is held and the key is special. Modifier boxes that are only still visible do not count.

### Visibility

- A run stays visible for `keys.run_visible_ms`.
- The timer restarts each time the run gains or loses a character.
- The newest run ignores its timer while any of its keys is physically held. The timer starts when the last one is released. This keeps `Ctrl` visible through a long Ctrl+click.
- A run replaced as newest by another run starts its timer at that moment, even if its keys are still held. A timer that is already running keeps going and doesn't restart.
- A quick tap gets the same full visible time.

### Held key colour

If `text.held_color` is set, the label of any key that is physically held uses that colour. If it is `null`, held keys use `text.color` like everything else.

- A modifier is only coloured in the newest row. With Ctrl held after Ctrl+C and Ctrl+V, `Ctrl` is coloured on the `Ctrl` `v` row only.
- Any other held key is coloured on whichever row shows it.
- In a modifier run, each part is coloured separately, and the `+` keeps `text.color`.
- In a text run, only the characters or tokens whose keys are held are coloured, and of a repeating key only the latest one, and this takes priority over `text.muted_color`. The box needs per-character styling, and text must be escaped if this uses Pango markup.
- The colour reverts as soon as the key is released, including for left and right variants once neither is held.

### Stack

- The newest run sits at the anchor point. A new run moves the older ones by one row, in the direction set by `keys.stack_direction` (`up` or `down`).
- When a run disappears, it fades out over `box.fade_out_ms`. It keeps its place in the stack while it fades, so new rows still push it along, and the runs further from the anchor close the gap when the fade ends.
- Movement is instant, with no animation. A row replaced in place (see "Shift and AltGr") doesn't fade.
- There are at most `keys.max_runs` rows. Past that limit, or when a row would leave the monitor, the oldest run is removed early. The newest run is never removed this way.

### Text runs

- A **printable key** is any key with visible text, including Space and keypad digits. A printable key that isn't chorded joins the current text run.
- Text comes from each key's locked label. Space appears as `keys.space_symbol` so that trailing spaces stay visible.
- A held key repeats at the rate from GNOME's keyboard settings (`delay` and `repeat-interval` in `org.gnome.desktop.peripherals.keyboard`), read at switch-on, unless `keys.repeat_delay_ms` or `keys.repeat_interval_ms` overrides them. Compositor repeat is what applications follow. The kernel's repeat events have their own rate, so the helper still ignores them.
  - Only a typed character repeats, and only the most recently pressed key. Releasing that key ends the repeat, and a repeat doesn't restart for a key still held.
  - A repeat uses the label locked at press, and a chorded key doesn't repeat. A modifier that shows ends the repeat.
  - A held Backspace erases one character, because a display can't reliably follow how far an application has really erased.
  - Repeats are predicted from those settings and can drift from an application that handles them differently.
- Keys held at the same time merge. Holding A and S shows one box, `as`.
- A new text run starts when any of these is true:
  - There is no current text run, for example because the last one expired or a modifier run came after it.
  - No text run key has been pressed or released for `keys.run_gap_ms`.
  - The previous key in the run was Enter.
- Mouse activity doesn't affect text runs.

### Special keys in a text run

A special key that isn't chorded goes into the text run as a token. It counts as typing, so it restarts the timers.

- **Token display:** Enter shows as `⏎`, Tab as `⇥`, and arrows as their arrows. Other keys show their label in angle quotes, such as `‹Esc›` or `‹F5›`, so they can't be mistaken for typed text. `keys.names` overrides change the label inside the quotes.
- **Enter:** it joins the current run and ends it. Typing `hello`, Enter, `world` shows `hello⏎` and `world` on two rows. An Enter with no current run shows a run containing just `⏎`.
- **Backspace:** if the last item in the current run is a character, it erases that character, including a space or dead key.
  - If the last item is a token, or there is no current run, Backspace is shown as a `⌫` token. In `abc←`, it gives `abc←⌫`.
  - If erasing leaves a run empty, that run is removed, and the next key starts a new run. Backspace never reaches back into an earlier row.
  - A Backspace after the `keys.run_gap_ms` gap starts a new run showing `⌫`, so it doesn't erase from the old run.
  - Backspace only edits what keymon displays, and may not match the text in the application.

### Modifier runs

- Pressing a hard modifier always ends the current text run. Text typed after a modifier run never joins an earlier text run.
- With no modifier run in progress, a modifier press starts a new run showing only that modifier, immediately.
- A further modifier pressed while the current run has only modifiers joins that run, provided a modifier in it is still held. If none is held, it starts a new run. Tapping Ctrl and then Alt gives two rows.
- A chorded key completes the run:
  - If the newest run has only modifiers, and those are exactly the modifiers now held, the key is added to it. Otherwise a new run starts with the held modifiers and the key.
  - A run holds one such key. Ctrl down, `c`, `v`, Ctrl up gives `Ctrl` `c` and `Ctrl` `v` on two rows.
  - Ctrl down, `c`, Ctrl up, `m` gives `Ctrl` `c`, then a text run `m`.
  - Pressing a modifier while the last run already has a key starts a new run containing all held modifiers. Ctrl+C, then Shift with Ctrl still held, gives `Ctrl` `Shift`.
- A modifier released before a key is pressed isn't shown with that key. Ctrl and Alt down, Alt up, `c` leaves `Ctrl` `Alt` on one row, and adds `Ctrl` `c` on a new one.
- A mouse click doesn't change a modifier run, and is not its one key.

### Shift and AltGr

The same rules apply to Shift and AltGr. The delay is `keys.shift_delay_ms`, measured from the press.

A press with no hard modifier held is **pending**, and shows nothing. It resolves as follows:

| What happens next | Result |
|---|---|
| A printable key within the delay | The modifier is **absorbed**, and the character goes into the current text run under the usual rules |
| A special key within the delay | Modifier run, as `Shift` `⇥`, immediately |
| A hard modifier or mouse press within the delay | Modifier run including it, immediately. Shift+click shows at the click |
| Nothing within the delay, held or not | Standalone modifier run at the end of the delay, which ends the current text run |

The modifier's release doesn't change this. Shift down, Shift up, then `1` within the delay types an unshifted `1`, and no `Shift` row appears.

Once it has resolved, for as long as it stays held:

- **After absorption:** further printable keys stay in text under the usual rules, however slowly they are typed, so `keys.run_gap_ms` can still start a new text run, but no `Shift` row appears. A special key or mouse press starts a modifier run.
- **After a standalone run:** the first printable key replaces the `Shift` row in place with a new text run, such as `!`. It doesn't merge into any earlier run, and further printable keys join this new run. A special key is added to the `Shift` row as in "Modifier runs". A row made by Shift+click behaves the same way.
- **After the modifier is released:** a standalone run simply stays until its timer ends. The next printable key starts a new text run on a new row.

A Shift or AltGr press while a hard modifier is held skips all of this and joins the run immediately. Ctrl+Shift+T shows `Ctrl` `Shift` `T`.

### Stale state

- A release with no matching press is ignored. This covers a toggle shortcut still held when keymon switches on.
- When the helper disconnects, or keymon switches off, all held-key state, pending modifiers, and runs clear.

## 8. Mouse display behaviour

- While active, the extension reads `global.get_pointer()` once per frame for position and button state, using a `Clutter.Timeline` on the ring so it follows the frame clock of the monitor the ring is on.
- Left, middle, and right buttons are tracked. Touchpad tap-to-click counts, because polling sees the compositor's logical buttons.
- Back, forward, and other side buttons are ignored.

### Permanent ring

- A circle centred on the pointer, with a configurable radius, stroke width, stroke colour, and fill colour (transparent by default).
- It moves across both monitors, and is hidden only when keymon is off.
- It stays visible when an app hides the cursor.

The ring looks the same whether or not a button is held.

### Click ripple

- On every press transition, a ripple starts at the pointer's position: a filled disc, drawn under the ring.
- Its radius goes from 0 to the permanent ring's radius over `mouse.ripple.duration_ms`, at opacity `mouse.ripple.start_opacity`.
- While its button is held, the ripple stays at that opacity and follows the pointer. This is the held state.
- On release, it stops where the pointer is and its opacity goes to 0 over `mouse.ripple.duration_ms`. If it hasn't finished growing, it keeps growing while it fades. Both use ease-out easing by default.
- Each button has its own colour.
- Ripples overlap independently. A new click does not cancel an earlier ripple, and each held button has its own.
- No new ripple starts on release, and a button already held at switch-on gets none.

A press and release that both fall between two frames is missed. At 60 Hz this needs a click shorter than about 17 ms, which is accepted.

## 9. Placement and rendering

- All actors belong to GNOME Shell's top chrome, above windows and panels, including fullscreen windows.
- All actors are non-reactive, so clicks pass through and the overlay never takes focus.
- While keymon is on, the extension calls `Meta.disable_unredirect_for_display()`, so that direct scanout of a fullscreen window cannot bypass the actors. It re-enables this when switched off.
- Sizes and offsets are in logical pixels.

### Key overlay placement

- The run stack is shown only on `overlay.monitor`: `"primary"` or a connector name such as `"DP-1"`.
- If the named monitor is absent, it falls back to primary. It repositions when monitors change.
- `overlay.origin_h` and `overlay.origin_v` select a point on the monitor, and `overlay.offset_x` and `offset_y` move on from there. Positive offsets always move right and down.
- `overlay.anchor_h` and `overlay.anchor_v` select the point on the newest row that goes at the result. `bottom` + `center` puts that row's bottom-centre there. To measure from the monitor's top-left corner, use origin `left` + `top`.
- Each row grows away from the horizontal anchor: to the right when `left`, to the left when `right`, and in both directions when `center`. All rows share that alignment, and the lines of a wrapped box are aligned the same way.
- Older rows extend in the `keys.stack_direction` direction, whatever the vertical anchor. With `top` + `up`, older rows would leave the monitor, so they are removed as described in §7.

## 10. Lifecycle and privacy

### On/off

- keymon is off after login. The extension is loaded but idle: no helper connection, no pointer tracking, no actors.
- The panel icon and a global shortcut (`toggle_shortcut`) switch it on and off.
- Switching off closes the helper connection, stops pointer tracking, and removes all actors immediately.
- Clicking the panel icon toggles keymon, with no menu. The icon is always a keyboard, and its colour shows three states: grey for off, yellow for on, and red for error.

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
- Colours are CSS strings such as `#ffffff`, `rgba(0,0,0,0.75)`, `hsl(45,100%,50%)`, or `hsla(45,100%,50%,0.5)`. Saturation and lightness need their `%` signs.

| Key | Default | Meaning |
|---|---|---|
| `toggle_shortcut` | `"<Super><Alt>k"` | Global on/off shortcut, applied through the extension's GSettings key |
| `overlay.monitor` | `"primary"` | `"primary"` or a connector name |
| `overlay.origin_h` | `"center"` | Point on the monitor the offset starts from: `left`, `center`, or `right` |
| `overlay.origin_v` | `"bottom"` | Same, vertically: `top`, `center`, or `bottom` |
| `overlay.anchor_h` | `"center"` | Point on the newest row placed there, and the alignment of wrapped lines: `left`, `center`, or `right` |
| `overlay.anchor_v` | `"bottom"` | Same, vertically: `top`, `center`, or `bottom` |
| `overlay.offset_x` | `0` | Horizontal shift in px |
| `overlay.offset_y` | `-80` | Vertical shift in px |
| `overlay.row_spacing` | `8` | Gap between rows in px |
| `box.background` | `"rgba(0,0,0,0.75)"` | Box background |
| `box.padding_h` | `16` | Horizontal padding in px |
| `box.padding_v` | `8` | Vertical padding in px |
| `box.corner_radius` | `12` | Corner radius in px |
| `box.fade_out_ms` | `200` | Fade-out when a box is removed. `0` removes it at once |
| `box.max_width` | `800` | Maximum box width in px, including padding. Wider content wraps onto more lines |
| `text.color` | `"#ffffff"` | Text colour |
| `text.held_color` | `"#ffcc00"` | Optional text colour for keys currently held. `null` uses `text.color` |
| `text.muted_color` | `"rgba(255,255,255,0.8)"` | Text colour for modifier runs, and for special keys and the space symbol in a text run. `null` uses `text.color` |
| `text.size` | `28` | Text size in px |
| `text.font` | `"sans"` | Font family |
| `text.line_height` | `1.25` | Line height, as a multiple of the normal height. The space above the first line and below the last comes out of `box.padding_v`, so a box keeps its size unless the padding runs out. A symbol from a taller fallback font doesn't change it |
| `text.weight` | `"normal"` | Font weight: `normal`, `bold`, or a number from `100` to `900` |
| `keys.run_visible_ms` | `3000` | How long a run stays visible |
| `keys.run_gap_ms` | `2000` | Time without typing before a new text run starts |
| `keys.repeat_delay_ms` | `null` | Delay before a held key repeats. `null` uses GNOME's setting |
| `keys.repeat_interval_ms` | `null` | Time between repeats, which can be fractional. `null` uses GNOME's setting plus 1.4 ms, the measured lag of applications |
| `keys.shift_delay_ms` | `200` | Time for a key to follow Shift or AltGr before it counts as a modifier |
| `keys.max_runs` | `5` | Maximum rows in the stack |
| `keys.stack_direction` | `"up"` | Direction older runs move: `up` or `down` |
| `keys.space_symbol` | `"␣"` | Space, in any run |
| `keys.names` | `{}` | Keysym name to label overrides |
| `mouse.ring.radius` | `28` | Permanent ring and final ripple radius in px |
| `mouse.ring.stroke_width` | `3` | Ring stroke in px |
| `mouse.ring.stroke_color` | `"#ffcc00"` | Ring colour |
| `mouse.ring.fill_color` | `"rgba(0,0,0,0)"` | Ring fill |
| `mouse.colors.left` | `"#ffcc00"` | Left button ripple colour |
| `mouse.colors.middle` | `"#00ccff"` | Middle button ripple colour |
| `mouse.colors.right` | `"#cc00ff"` | Right button ripple colour |
| `mouse.ripple.duration_ms` | `300` | Time a ripple takes to grow, and to fade after release |
| `mouse.ripple.start_opacity` | `0.8` | Opacity of a ripple until its button is released |
| `mouse.ripple.easing` | `"ease-out"` | `linear`, `ease-in`, `ease-out`, or `ease-in-out` |

## 12. Error handling

| Situation | Behaviour |
|---|---|
| Socket or service is missing | Mouse display still works, panel icon shows error, and one notification explains how to run the installer |
| Helper disconnects while on | Boxes clear, then reconnect with backoff of 1, 2, 4, up to 30 s, with the icon in error until reconnected |
| No keyboard device found | Helper stays connected and keeps rescanning |
| `keymon-keymap` fails, or layout is unknown | Falls back to `us`, with one notification |
| Keycode has no table entry | Box shows `Key<code>` |
| Monitor added or removed | Stack repositions with no restart |
| Exception in the extension | Logged to the journal under a `keymon` prefix, and keymon switches off rather than leaving stale overlays |

## 13. Installation

`install.sh` in the repo:

1. Checks for GNOME Shell 46 and a Wayland session.
2. Installs `python3-evdev` with apt.
3. Installs the helper to `/usr/local/lib/keymon/`, installs the systemd units, and enables `keymon.socket`. Steps 2 and 3 use sudo.
4. Installs the extension to `~/.local/share/gnome-shell/extensions/keymon@local/`, with `keymon-keymap`, and compiles its GSettings schema.
5. Tells the user to log out and in, because Wayland GNOME Shell cannot load a new extension without that.

If the extension path is already a symlink to this repo, as `dev/link-extension.sh` makes it, step 4 keeps the link and only compiles the schema. A symlink to anywhere else stops the installer before it changes anything.

`uninstall.sh` reverses all of these steps, except that it leaves the config file and the `python3-evdev` package in place. It prints the command to remove the package, which may also serve something else. A symlink at the extension path is removed without touching what it points to, and a symlink to anywhere but this repo stops the script before it changes anything.

### Proposed repo layout

```
SPEC.md
install.sh, uninstall.sh
config.example.json
extension/      metadata.json, extension.js, state.js, overlay.js, pointer.js, keymon-keymap, schemas/
helper/         keymon-helper, keymon.service, keymon.socket
tests/
```

`state.js` holds the display state machine from §7. It must have no Shell imports, and takes events and a clock as inputs, so that it can be tested under plain `gjs`.

## 14. Acceptance criteria

**Keys**

1. Holding Ctrl and Shift with another app focused shows one box, `Ctrl+Shift`. Pressing Ctrl shows its box immediately, and it stays through a long Ctrl+click until `keys.run_visible_ms` after release.
2. A very short tap of any key stays visible for `keys.run_visible_ms`.
3. Typing `hello` shows one box, and each character restarts its timer. A pause of 2 s before more typing starts a new run, and older rows move in the `keys.stack_direction` direction.
4. `hello`, Enter, `world` shows `hello⏎` and `world` on two rows. Backspace erases the last character. With no character to erase, it shows `⌫`.
5. Ctrl down, `c`, `v`, Ctrl up shows two rows, `Ctrl+c` and `Ctrl+v`. A following `m` starts a separate text run, and an earlier text run keeps its row until its timer ends.
6. Shift+1 typed quickly appends `!` to the current run, with no `Shift` row. Shift alone shows a `Shift` row after 200 ms. Pressing `1` while that row is held replaces it with `!`, not merged into any earlier run. Shift+Tab shows `Shift+⇥`.
7. Shift+1 shows `!` on `us`. The same physical key shows the correct character after switching to `be`.
8. Holding a key adds characters at the same rate as the focused application, and holding Backspace erases one character. With `text.held_color` set, the latest character of the held key uses the colour until release, and the rest of the run keeps `text.color`.
9. Holding 1 then pressing Shift leaves the label as `1`.

**Mouse**

10. The ring follows the pointer across both monitors, with no visible offset at scale 1.0.
11. Every left, middle, and right press gives one ripple from radius 0 to ring radius, fading out after release, in that button's colour.
12. Rapid clicks produce overlapping ripples.
13. While dragging, the ring doesn't change and the ripple stays visible and follows the pointer, until it fades on release.

**System**

14. The overlay never blocks clicks or takes focus, including above fullscreen windows.
15. Every origin and anchor combination places the newest row correctly on the configured monitor, and `keys.max_runs` limits the stack.
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
