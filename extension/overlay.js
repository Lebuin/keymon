// Draws the runs from the display state as click-through rows in the top chrome.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {placeRows, runItems, textMarkup} from './layout.js';

// Pango has no rgba() form, so a CSS colour becomes #rrggbbaa.
function pangoColor(css) {
    if (css === null)
        return null;
    const [ok, color] = Clutter.Color.from_string(css);
    if (!ok)
        return null;
    const hex = [color.red, color.green, color.blue, color.alpha]
        .map(part => part.toString(16).padStart(2, '0'));
    return `#${hex.join('')}`;
}

export class KeyOverlay {
    // guard(callback) runs what this class starts by itself, outside render().
    constructor(config, guard) {
        this._config = config;
        this._guard = guard;
        this._stack = []; // Newest first: {id, row, size, fading}.
        this._colors = {
            held: pangoColor(config.text.held_color),
            muted: pangoColor(config.text.muted_color),
        };
        // St sets the line alignment from the style, so it has to be set here.
        this._boxStyle =
            `text-align: ${config.overlay.anchor_h};` +
            `background-color: ${config.box.background};` +
            `padding: ${config.box.padding_v}px ${config.box.padding_h}px;` +
            `border-radius: ${config.box.corner_radius}px;` +
            `font-family: ${config.text.font}; font-weight: ${config.text.weight};` +
            `font-size: ${config.text.size}px;` +
            `color: ${config.text.color};`;

        this._root = new St.Widget({reactive: false, can_focus: false, track_hover: false});
        Main.layoutManager.addTopChrome(this._root, {affectsInputRegion: false});
        this._reducePadding();
    }

    // Extra line height also goes above the first line and below the last, so the
    // padding gives that back to keep the configured space around the text.
    _reducePadding() {
        const {padding_h: paddingH, padding_v: paddingV} = this._config.box;
        const probe = new St.Label({text: 'x', style: this._boxStyle});
        this._root.add_child(probe);
        const line = probe.get_preferred_height(-1)[1] - 2 * paddingV;
        probe.destroy();

        this._lineHeight = line * this._config.text.line_height;
        const extra = (this._lineHeight - line) / 2;
        const padding = Math.max(Math.round(paddingV - extra), 0);
        this._boxStyle += `padding: ${padding}px ${paddingH}px;`;
    }

    destroy() {
        Main.layoutManager.removeChrome(this._root);
        this._root.destroy();
        this._root = null;
    }

    // Rebuilds the rows. Runs that would leave the monitor are removed from the
    // state as well, so they don't come back when newer runs expire. A row whose
    // run is gone keeps its place in the stack while it fades out, so new rows push
    // it along, and the rows beyond it close the gap when it is done. A run removed
    // by keys.max_runs goes at once, with no fade.
    render(state) {
        const monitor = this._monitor();
        const maxWidth = Math.min(this._config.box.max_width, monitor.width);
        const runs = state.runs();
        const shown = new Set(this._stack.map(entry => entry.id));
        const limited = new Set(state.takeLimited());
        const rebuilt = new Map(runs.map(run => [run.id, this._makeEntry(run, maxWidth)]));

        // New runs are always the newest, and the rest keep their order.
        const stack = runs.filter(run => !shown.has(run.id)).map(run => rebuilt.get(run.id));
        for (const entry of this._stack) {
            if (rebuilt.has(entry.id)) {
                entry.row.destroy();
                stack.push(rebuilt.get(entry.id));
            } else if (limited.has(entry.id)) {
                entry.row.destroy();
            } else if (entry.fading || this._fadeOut(entry, state)) {
                stack.push(entry);
            }
        }

        const positions = placeRows(
            monitor, stack.map(entry => entry.size), this._config.overlay, this._config.keys.stack_direction);
        for (const [index, {x, y}] of positions.entries())
            stack[index].row.set_position(x, y);
        for (const entry of stack.slice(positions.length)) {
            entry.row.destroy();
            if (!entry.fading)
                state.dropOldest();
        }
        this._stack = stack.slice(0, positions.length);
    }

    // Returns whether the row is still there, fading.
    _fadeOut(entry, state) {
        const duration = this._config.box.fade_out_ms;
        if (duration <= 0) {
            entry.row.destroy();
            return false;
        }
        entry.fading = true;
        entry.row.ease({
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._guard(() => {
                this._stack = this._stack.filter(other => other !== entry);
                entry.row.destroy();
                this.render(state);
            }),
        });
        return true;
    }

    _monitor() {
        const {monitor} = this._config.overlay;
        if (monitor !== 'primary') {
            const index = global.backend.get_monitor_manager().get_monitor_for_connector(monitor);
            if (index >= 0)
                return Main.layoutManager.monitors[index];
        }
        return Main.layoutManager.primaryMonitor;
    }

    _makeEntry(run, maxWidth) {
        const row = new St.Label({
            reactive: false,
            can_focus: false,
            track_hover: false,
            style: this._boxStyle,
        });
        row.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.NONE,
        });
        row.clutter_text.set_markup(textMarkup(runItems(run), this._colors, this._config.text.size, this._lineHeight));
        this._root.add_child(row);

        // A row wider than the limit wraps, which makes it taller.
        const width = Math.min(row.get_preferred_width(-1)[1], maxWidth);
        row.set_width(width);
        return {id: run.id, row, size: {width, height: row.get_preferred_height(width)[1]}, fading: false};
    }
}
