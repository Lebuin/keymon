// The on/off lifecycle: the panel icon and shortcut, the config file, the helper
// connection, and the displays that exist only while keymon is on.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {CONFIG_PATH, ConfigWatcher, mergeConfig, readConfig} from './config.js';
import {Indicator} from './indicator.js';
import {Backoff, KeyClient, SOCKET_PATH} from './keyclient.js';
import {KeyResolver, loadKeymap} from './keymap.js';
import {KeyOverlay} from './overlay.js';
import {PointerDisplay} from './pointer.js';
import {DisplayState} from './state.js';

const FALLBACK_LAYOUT = 'us';
// Applications repeat a little slower than GNOME's setting asks for. Measured with
// dev/measure-repeat.py: 28.43 ms at a setting of 27 ms.
const REPEAT_LAG_MS = 1.2;
// A connection that lasted this long was working, so the next retry waits the least.
const STABLE_CONNECTION_MS = 30000;

function log(message) {
    console.log(`keymon: ${message}`);
}

function now() {
    return Math.floor(GLib.get_monotonic_time() / 1000);
}

// Clutter reads forms such as hsl() that St's CSS parser doesn't, so St gets rgba().
function colorToCss(css) {
    const [ok, color] = Clutter.Color.from_string(css);
    return ok ? `rgba(${color.red},${color.green},${color.blue},${color.alpha / 255})` : null;
}

export default class KeymonExtension extends Extension {
    // GNOME disables the extension on lock and enables it again on unlock, on this
    // same object. So what is kept here between the two lasts until logout only:
    // _config, _tables, _keymapWarned, _session, and _resumeOn.
    enable() {
        this._settings = this.getSettings();
        this._inputSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
        this._on = false;
        this._session ??= 0; // Tells a switch-on still loading from a newer one.
        this._tables ??= new Map(); // Layout and options to a promise of the table.
        this._config ??= mergeConfig({}); // The last valid config.

        this._reloadConfig();
        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._guard(() => this._toggle()));

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._guard(() => this._render()));
        this._watcher = new ConfigWatcher(CONFIG_PATH, () => this._guard(() => this._reloadConfig()));
        this._indicator = new Indicator(this.uuid, () => this._guard(() => this._toggle()));
        this._watchLoginSession();

        if (this._resumeOn) {
            this._resumeOn = false;
            this._guard(() => this._show());
        }
    }

    disable() {
        // Only a lock comes back on by itself, not switching the extension off.
        this._resumeOn = this._on && Main.sessionMode.isLocked;
        this._hide();

        if (this._loginSessionId) {
            this._loginSession.disconnect(this._loginSessionId);
            this._loginSessionId = 0;
        }
        this._loginSession = null;

        this._indicator.destroy();
        this._indicator = null;
        this._watcher.destroy();
        this._watcher = null;
        Main.layoutManager.disconnect(this._monitorsChangedId);
        Main.wm.removeKeybinding('toggle-shortcut');

        this._inputSettings = null;
        this._settings = null;
    }

    // Keeps stale overlays off the screen if anything goes wrong while running.
    _guard(callback) {
        try {
            callback();
        } catch (e) {
            this._fail(e);
        }
    }

    _fail(e) {
        console.error(`keymon: switching off after an error: ${e.message}\n${e.stack}`);
        this._hide();
    }

    _toggle() {
        if (this._on) {
            this._hide();
            return;
        }
        this._show();
    }

    // Key events are discarded while another virtual terminal has the session.
    async _watchLoginSession() {
        const settings = this._settings;
        try {
            const session = await LoginManager.getLoginManager().getCurrentSessionProxy();
            if (!session || this._settings !== settings)
                return;
            this._loginSession = session;
            this._loginSessionId = session.connect('g-properties-changed', () => this._guard(() => {
                if (!this._sessionActive() && this._on)
                    this._clearKeys();
            }));
        } catch (e) {
            log(`no login session to watch: ${e.message}`);
        }
    }

    _sessionActive() {
        return this._loginSession?.Active !== false;
    }

    _reloadConfig() {
        const {config, error} = readConfig(CONFIG_PATH, colorToCss);
        if (error) {
            log(`config not applied: ${error}`);
            Main.notify('keymon', `Config not applied, keeping the last valid one: ${error}`);
            return;
        }
        this._config = config;
        const shortcut = [config.toggle_shortcut];
        if (this._settings.get_strv('toggle-shortcut').join() !== shortcut.join())
            this._settings.set_strv('toggle-shortcut', shortcut);

        if (!this._on)
            return;
        this._destroyDisplays();
        this._makeDisplays();
        this._state.setConfig(this._withRepeat(config.keys));
        this._update();
    }

    // Made in this order, so that the pointer is drawn over the key overlay.
    _makeDisplays() {
        this._overlay = new KeyOverlay(this._config, callback => this._guard(callback));
        this._pointer = new PointerDisplay(this._config.mouse, () => {
            this._state.mouseDown();
            this._update();
        }, callback => this._guard(callback));
    }

    _destroyDisplays() {
        this._pointer?.destroy();
        this._pointer = null;
        this._overlay?.destroy();
        this._overlay = null;
    }

    _show() {
        this._on = true;
        this._helperOk = true;
        this._helperWarned = false;
        this._connectedAt = null;
        this._backoff = new Backoff();

        // Direct scanout of a fullscreen window would bypass our actors.
        Meta.disable_unredirect_for_display(global.display);

        this._state = new DisplayState(this._withRepeat(this._config.keys), now);
        this._resolver = new KeyResolver();
        this._keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        this._makeDisplays();

        const sources = getInputSourceManager();
        this._sourceChangedId = sources.connect(
            'current-source-changed', () => this._useCurrentLayout().catch(e => this._fail(e)));
        this._syncIndicator();

        const session = ++this._session;
        this._connectWhenReady(session).catch(e => {
            if (session === this._session)
                this._fail(e);
        });
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

    // Each step runs even if an earlier one fails, so nothing stays on screen.
    _hide() {
        if (!this._on)
            return;
        this._on = false;

        const steps = [
            () => {
                if (this._sourceChangedId)
                    getInputSourceManager().disconnect(this._sourceChangedId);
                this._sourceChangedId = 0;
            },
            () => this._client?.close(),
            () => this._removeSource('_timeoutId'),
            () => this._removeSource('_retryId'),
            () => Meta.enable_unredirect_for_display(global.display),
            () => this._destroyDisplays(),
            () => this._syncIndicator(),
        ];
        for (const step of steps) {
            try {
                step();
            } catch (e) {
                console.error(`keymon: while switching off: ${e.message}\n${e.stack}`);
            }
        }

        this._client = null;
        this._state = null;
        this._resolver = null;
        this._keymap = null;
    }

    _removeSource(name) {
        if (this[name])
            GLib.source_remove(this[name]);
        this[name] = 0;
    }

    _syncIndicator() {
        if (!this._on)
            this._indicator?.setState('off');
        else
            this._indicator?.setState(this._helperOk ? 'on' : 'error');
    }

    // Loading every configured layout up front makes a layout switch apply to the
    // very next key press. The helper connects only once a table is in place.
    async _connectWhenReady(session) {
        const sources = Object.values(getInputSourceManager().inputSources);
        await Promise.all(sources.map(source => this._tableFor(source.xkbId)));
        if (!this._on || session !== this._session)
            return;
        await this._useCurrentLayout();
        if (!this._on || session !== this._session)
            return;

        this._client = new KeyClient(SOCKET_PATH, {
            onConnected: () => this._guard(() => this._onConnected()),
            onKey: (code, down) => this._guard(() => this._onKey(code, down)),
            onDisconnected: (message, wasConnected) =>
                this._guard(() => this._onDisconnected(message, wasConnected)),
        });
        this._client.connect();
    }

    _onConnected() {
        log('connected to the helper');
        this._connectedAt = now();
        this._helperOk = true;
        this._syncIndicator();
    }

    _onDisconnected(message, wasConnected) {
        log(`helper unavailable: ${message}`);
        if (!wasConnected && !this._helperWarned) {
            this._helperWarned = true;
            Main.notify('keymon',
                `The key helper is unavailable, so only the mouse is shown. Run install.sh from the keymon repo to set it up. (${message})`);
        }
        this._helperOk = false;
        this._syncIndicator();
        this._clearKeys();

        if (this._connectedAt !== null && now() - this._connectedAt >= STABLE_CONNECTION_MS)
            this._backoff.reset();
        this._connectedAt = null;
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._backoff.next(), () => {
            this._retryId = 0;
            this._guard(() => this._client.connect());
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearKeys() {
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
        const options = this._inputSettings?.get_strv('xkb-options') ?? [];
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
        if (!this._sessionActive())
            return;
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
        this._removeSource('_timeoutId');
        const deadline = this._state.nextDeadline();
        if (deadline === null)
            return;
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, Math.max(Math.ceil(deadline - now()), 0), () => {
                this._timeoutId = 0;
                this._guard(() => {
                    this._state.tick();
                    this._update();
                });
                return GLib.SOURCE_REMOVE;
            });
    }
}
