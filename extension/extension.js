// Stage 2: a click-through ring, and a box that shows raw key codes from the
// helper. The toggle shortcut switches both on and off.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KeyClient, SOCKET_PATH} from './keyclient.js';

const RING_RADIUS = 28;
const BOX_OFFSET_Y = -80;
const DEFAULT_SHORTCUT = '<Super><Alt>k';
const RAW_EVENTS_SHOWN = 8;

function log(message) {
    console.log(`keymon: ${message}`);
}

function readConfig() {
    const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'keymon', 'config.json']);
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            log(`config not used: ${e.message}`);
        return {};
    }
}

export default class KeymonExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._on = false;

        this._applyShortcut(readConfig());
        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle());

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._placeBox());
    }

    disable() {
        this._hide();

        Main.layoutManager.disconnect(this._monitorsChangedId);
        Main.wm.removeKeybinding('toggle-shortcut');

        this._settings = null;
    }

    _toggle() {
        if (this._on) {
            this._hide();
            return;
        }
        // Rereading here lets the shortcut change without a logout.
        this._applyShortcut(readConfig());
        this._show();
    }

    _applyShortcut(config) {
        this._settings.set_strv('toggle-shortcut', [config.toggle_shortcut ?? DEFAULT_SHORTCUT]);
    }

    _show() {
        this._on = true;

        this._box = new St.Label({
            text: 'connecting',
            reactive: false,
            can_focus: false,
            track_hover: false,
            style: 'background-color: rgba(0,0,0,0.75); color: #ffffff;' +
                'font-family: sans; font-size: 28px; padding: 8px 16px; border-radius: 4px;',
        });
        Main.layoutManager.addTopChrome(this._box, {affectsInputRegion: false});
        this._placeBox();

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
        this._moveRing();

        // Direct scanout of a fullscreen window would bypass our actors.
        Meta.disable_unredirect_for_display(global.display);
        this._startTracking();

        this._rawEvents = [];
        this._client = new KeyClient(SOCKET_PATH, {
            onConnected: () => this._setBoxText('connected'),
            onKey: (code, down) => this._showKey(code, down),
            onDisconnected: message => {
                log(`helper unavailable: ${message}`);
                this._setBoxText('helper unavailable');
            },
        });
        this._client.connect();
    }

    _hide() {
        if (!this._on)
            return;
        this._on = false;

        this._client.close();
        this._client = null;

        this._stopTracking();
        Meta.enable_unredirect_for_display(global.display);

        Main.layoutManager.removeChrome(this._ring);
        this._ring.destroy();
        this._ring = null;

        Main.layoutManager.removeChrome(this._box);
        this._box.destroy();
        this._box = null;
    }

    _startTracking() {
        this._timeline = new Clutter.Timeline({
            actor: this._ring,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._moveRing());
        this._timeline.start();
    }

    _stopTracking() {
        this._timeline?.stop();
        this._timeline = null;
    }

    _moveRing() {
        const [x, y] = global.get_pointer();
        if (x === this._lastX && y === this._lastY)
            return;
        this._lastX = x;
        this._lastY = y;
        this._ring.set_position(x - RING_RADIUS, y - RING_RADIUS);
    }

    _showKey(code, down) {
        this._rawEvents.push(`${code}${down ? '↓' : '↑'}`);
        this._rawEvents = this._rawEvents.slice(-RAW_EVENTS_SHOWN);
        this._setBoxText(this._rawEvents.join(' '));
    }

    _setBoxText(text) {
        this._box.text = text;
        this._placeBox();
    }

    _placeBox() {
        if (!this._box)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const [, width] = this._box.get_preferred_width(-1);
        const [, height] = this._box.get_preferred_height(-1);
        this._box.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height - height + BOX_OFFSET_Y));
    }
}
