// Stage 4: a click-through ring, and the key overlay driven by the display state
// machine. The toggle shortcut switches both on and off.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {readConfig} from './config.js';
import {KeyClient, SOCKET_PATH} from './keyclient.js';
import {KeyResolver, loadKeymap} from './keymap.js';
import {KeyOverlay} from './overlay.js';
import {DisplayState} from './state.js';

const RING_RADIUS = 28;
const FALLBACK_LAYOUT = 'us';
// Applications repeat a little slower than GNOME's setting asks for. Measured with
// dev/measure-repeat.py: 28.43 ms at a setting of 27 ms.
const REPEAT_LAG_MS = 1.2;
const BUTTONS_MASK = Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

function log(message) {
    console.log(`keymon: ${message}`);
}

function now() {
    return Math.floor(GLib.get_monotonic_time() / 1000);
}

export default class KeymonExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._inputSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
        this._on = false;
        this._session = 0; // Tells a switch-on still loading from a newer one.
        this._tables = new Map(); // Layout and options to a promise of the table.
        this._keymapWarned = false;

        this._applyShortcut(readConfig());
        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle());

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._render());
    }

    disable() {
        this._hide();

        Main.layoutManager.disconnect(this._monitorsChangedId);
        Main.wm.removeKeybinding('toggle-shortcut');

        this._tables = null;
        this._inputSettings = null;
        this._settings = null;
    }

    _toggle() {
        if (this._on) {
            this._hide();
            return;
        }
        this._show();
    }

    _applyShortcut(config) {
        this._settings.set_strv('toggle-shortcut', [config.toggle_shortcut]);
    }

    _show() {
        this._on = true;
        // Rereading here lets config changes apply without a logout.
        const config = readConfig();
        this._applyShortcut(config);

        this._overlay = new KeyOverlay(config);
        this._state = new DisplayState(this._withRepeat(config.keys), now);
        this._resolver = new KeyResolver();
        this._keymap = Clutter.get_default_backend().get_default_seat().get_keymap();

        this._ring = new St.Widget({
            reactive: false,
            can_focus: false,
            track_hover: false,
            width: RING_RADIUS * 2,
            height: RING_RADIUS * 2,
            style: `border: 3px solid #ffcc00; border-radius: ${RING_RADIUS}px;` +
                'background-color: rgba(0,0,0,0);',
        });
        Main.layoutManager.addTopChrome(this._ring, {affectsInputRegion: false});
        this._lastX = this._lastY = null;
        this._lastButtons = global.get_pointer()[2] & BUTTONS_MASK;
        this._onFrame();

        // Direct scanout of a fullscreen window would bypass our actors.
        Meta.disable_unredirect_for_display(global.display);
        this._startTracking();

        const sources = getInputSourceManager();
        this._sourceChangedId = sources.connect(
            'current-source-changed', () => this._useCurrentLayout());
        this._connectWhenReady(++this._session);
    }

    // The compositor gives applications these same values, so repeats shown here
    // keep pace with what they type. The helper's kernel repeat events would not.
    // A value in the config wins, for matching an application that lags behind.
    _withRepeat(keys) {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.keyboard'});
        if (!settings.get_boolean('repeat'))
            return {...keys, repeat_delay_ms: null};
        return {
            ...keys,
            repeat_delay_ms: keys.repeat_delay_ms ?? settings.get_uint('delay'),
            repeat_interval_ms: keys.repeat_interval_ms ?? settings.get_uint('repeat-interval') + REPEAT_LAG_MS,
        };
    }

    _hide() {
        if (!this._on)
            return;
        this._on = false;

        getInputSourceManager().disconnect(this._sourceChangedId);

        this._client?.close();
        this._client = null;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._stopTracking();
        Meta.enable_unredirect_for_display(global.display);

        Main.layoutManager.removeChrome(this._ring);
        this._ring.destroy();
        this._ring = null;

        this._overlay.destroy();
        this._overlay = null;
        this._state = null;
        this._resolver = null;
        this._keymap = null;
    }

    // Loading every configured layout up front makes a layout switch apply to the
    // very next key press. The helper connects only once a table is in place.
    async _connectWhenReady(session) {
        const sources = Object.values(getInputSourceManager().inputSources);
        await Promise.all(sources.map(source => this._tableFor(source.xkbId)));
        await this._useCurrentLayout();
        if (!this._on || session !== this._session)
            return;

        this._client = new KeyClient(SOCKET_PATH, {
            onConnected: () => log('connected to the helper'),
            onKey: (code, down) => this._onKey(code, down),
            onDisconnected: message => this._onDisconnected(message),
        });
        this._client.connect();
    }

    _onDisconnected(message) {
        log(`helper unavailable: ${message}`);
        Main.notify('keymon', `The key helper is unavailable: ${message}`);
        this._resolver.reset();
        this._state.reset();
        this._update();
    }

    async _useCurrentLayout() {
        const xkbId = getInputSourceManager().currentSource?.xkbId ?? FALLBACK_LAYOUT;
        const table = await this._tableFor(xkbId);
        // The source may have changed again while this one loaded.
        const current = getInputSourceManager().currentSource?.xkbId ?? FALLBACK_LAYOUT;
        if (this._on && xkbId === current)
            this._resolver.setTable(table);
    }

    // Never rejects. A layout that fails falls back to us, and to an empty table
    // if even that fails, which shows every key by its code.
    _tableFor(xkbId) {
        const options = this._inputSettings.get_strv('xkb-options');
        const cacheKey = `${xkbId}|${options.join(',')}`;
        let table = this._tables.get(cacheKey);
        if (!table) {
            const tool = GLib.build_filenamev([this.path, 'keymon-keymap']);
            table = loadKeymap(tool, xkbId, options).catch(e => {
                log(`no keymap for ${xkbId}: ${e.message}`);
                if (!this._keymapWarned) {
                    this._keymapWarned = true;
                    Main.notify('keymon', `Could not read layout ${xkbId}, using ${FALLBACK_LAYOUT} labels.`);
                }
                return xkbId === FALLBACK_LAYOUT ? {} : this._tableFor(FALLBACK_LAYOUT);
            });
            this._tables.set(cacheKey, table);
        }
        return table;
    }

    _onKey(code, down) {
        if (down) {
            const key = this._resolver.keyDown(code, {
                capsLock: this._keymap.get_caps_lock_state(),
                numLock: this._keymap.get_num_lock_state(),
            });
            this._state.keyDown(code, key);
        } else {
            this._resolver.keyUp(code);
            this._state.keyUp(code);
        }
        this._update();
    }

    _render() {
        this._overlay?.render(this._state);
    }

    // Draws the current runs, and wakes up again when the next one is due.
    _update() {
        this._render();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const deadline = this._state.nextDeadline();
        if (deadline === null)
            return;
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, Math.max(Math.ceil(deadline - now()), 0), () => {
                this._timeoutId = 0;
                this._state.tick();
                this._update();
                return GLib.SOURCE_REMOVE;
            });
    }

    _startTracking() {
        this._timeline = new Clutter.Timeline({
            actor: this._ring,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._onFrame());
        this._timeline.start();
    }

    _stopTracking() {
        this._timeline?.stop();
        this._timeline = null;
    }

    _onFrame() {
        const [x, y, modifiers] = global.get_pointer();
        if (x !== this._lastX || y !== this._lastY) {
            this._lastX = x;
            this._lastY = y;
            this._ring.set_position(x - RING_RADIUS, y - RING_RADIUS);
        }

        const buttons = modifiers & BUTTONS_MASK;
        const pressed = buttons & ~this._lastButtons;
        this._lastButtons = buttons;
        if (pressed !== 0) {
            this._state.mouseDown();
            this._update();
        }
    }
}
