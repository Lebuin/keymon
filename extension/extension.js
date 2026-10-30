// Stage 1 prototype: a click-through ring and a static box, plus logged probes
// for the unknowns in SPEC.md section 15. Probe results go to the journal under
// a "keymon:" prefix.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const RING_RADIUS = 28;
const BOX_OFFSET_Y = -80;
const DEFAULT_SHORTCUT = '<Super><Alt>k';

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
        const action = Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle());
        log(`probe keybinding: action=${action} value=${this._settings.get_strv('toggle-shortcut')}`);

        this._inputSources = getInputSourceManager();
        this._sourceChangedId = this._inputSources.connect(
            'current-source-changed', () => this._probeInputSource());

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._placeBox());

        this._probeMonitors();
        this._probeInputSource();
        this._show();
    }

    disable() {
        this._hide();

        Main.layoutManager.disconnect(this._monitorsChangedId);
        this._inputSources.disconnect(this._sourceChangedId);
        Main.wm.removeKeybinding('toggle-shortcut');

        this._inputSources = null;
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
            text: 'keymon',
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
    }

    _hide() {
        if (!this._on)
            return;
        this._on = false;

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

    _probeMonitors() {
        const manager = global.backend.get_monitor_manager();
        for (const connector of ['eDP-1', 'DP-1', 'NOT-A-CONNECTOR'])
            log(`probe connector: ${connector} -> ${manager.get_monitor_for_connector(connector)}`);
        const monitors = Main.layoutManager.monitors.map(m => `${m.index}:${m.x},${m.y} ${m.width}x${m.height}`);
        log(`probe monitors: primary=${Main.layoutManager.primaryIndex} ${monitors.join(' ')}`);
    }

    _probeInputSource() {
        const source = this._inputSources.currentSource;
        const [layout, variant = ''] = source?.xkbId?.split('+') ?? [];
        const options = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'})
            .get_strv('xkb-options');
        log(`probe input source: type=${source?.type} layout=${layout} variant=${variant} ` +
            `options=[${options}]`);
    }
}
