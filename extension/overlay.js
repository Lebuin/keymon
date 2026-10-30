// Draws the runs from the display state as click-through rows in the top chrome.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {boxHeight, enteringPivot, enteringY, placeRows, restingItems, runItems, textMarkup} from './layout.js';

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
        this._slideId = 0; // The wait for a row to finish sliding in.
        this._stack = []; // Newest first: {id, row, size, fading, targetY}.
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
        this._paddingV = Math.max(Math.round(paddingV - extra), 0);
        this._boxStyle += `padding: ${this._paddingV}px ${paddingH}px;`;
    }

    destroy() {
        if (this._slideId)
            GLib.source_remove(this._slideId);
        this._slideId = 0;
        Main.layoutManager.removeChrome(this._root);
        this._root.destroy();
        this._root = null;
    }

    // Brings the rows up to date. A row whose run is gone keeps its place in the stack
    // while it fades out, so new rows push it along, and the rows beyond it slide over
    // the gap when it is done. Runs that would leave the monitor are removed from the
    // state as well, so they don't come back when newer runs expire, and fade the same
    // way. A new run waits while the previous one is still sliding in, and the first
    // run on an empty screen appears at once unless box.animate_first is set.
    render(state, slide = false) {
        this._state = state;
        const monitor = this._monitor();
        const maxWidth = Math.min(this._config.box.max_width, monitor.width);
        const runs = new Map(state.runs().map(run => [run.id, run]));

        this._stack = this._stack.filter(entry => {
            const run = runs.get(entry.id);
            if (run && !entry.fading) {
                this._updateEntry(entry, run, maxWidth);
                return true;
            }
            return entry.fading || this._fadeOut(entry);
        });

        // New runs are always the newest, so the oldest of them goes in front.
        const shown = new Set(this._stack.map(entry => entry.id));
        const waiting = [...runs.values()].filter(run => !shown.has(run.id)).reverse();
        const animate = this._config.box.animation_ms > 0;
        const turns = !animate ? waiting.length : this._slideId ? 0 : 1;
        const entering = waiting.slice(0, turns).map(run => this._makeEntry(run, maxWidth));
        // With nothing on screen there is nothing to make room for, so it can just appear.
        const appears = this._stack.length === 0 && !this._config.box.animate_first;
        for (const entry of entering)
            this._stack.unshift(entry);

        const sizes = this._stack.map(entry => entry.size);
        const {overlay, keys: {stack_direction: direction}} = this._config;
        const fitting = placeRows(monitor, sizes, overlay, direction).length;
        for (const entry of this._stack.slice(fitting)) {
            if (!entry.fading && state.dropOldest() && !this._fadeOut(entry))
                this._stack = this._stack.filter(other => other !== entry);
        }

        const positions = placeRows(monitor, this._stack.map(entry => entry.size), overlay, direction, false);
        if (animate && entering.length > 0 && !appears) {
            this._slideIn(entering[0], positions[0], overlay.row_spacing, direction);
            slide = true;
        }
        for (const [index, {x, y}] of positions.entries())
            this._moveRow(this._stack[index], x, y, slide || Boolean(this._slideId));
    }

    // Starts from where a row before the newest would be, zoomed out, and blocks the
    // next new run until it has arrived.
    _slideIn(entry, position, spacing, direction) {
        const {animation_ms: duration, enter_scale: scale} = this._config.box;
        entry.row.pivot_point = new Graphene.Point(enteringPivot(this._config.overlay.anchor_h, direction));
        entry.row.set_scale(scale, scale);
        entry.row.set_position(position.x, enteringY(position.y, entry.size.height, spacing, direction));
        entry.row.opacity = 0;
        entry.row.ease({opacity: 255, scale_x: 1, scale_y: 1, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._slideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            this._slideId = 0;
            this._guard(() => this.render(this._state));
            return GLib.SOURCE_REMOVE;
        });
    }

    // Sideways is always instant, since a growing row with a right or centre anchor
    // moves on every key.
    _moveRow(entry, x, y, slide) {
        entry.row.x = x;
        if (y === entry.targetY)
            return;
        entry.targetY = y;
        const duration = this._config.box.animation_ms;
        if (slide && duration > 0) {
            entry.row.ease({y, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            entry.row.remove_transition('y');
            entry.row.y = y;
        }
    }

    // Returns whether the row is still there, fading.
    _fadeOut(entry) {
        const duration = this._config.box.animation_ms;
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
                this.render(this._state, true);
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
        this._root.add_child(row);
        const entry = {id: run.id, row, size: null, fading: false, targetY: null};
        this._updateEntry(entry, run, maxWidth);
        return entry;
    }

    _updateEntry(entry, run, maxWidth) {
        const {row} = entry;
        const items = runItems(run);
        const markup = shown => textMarkup(shown, this._colors, this._config.text.size, this._lineHeight);

        // A row wider than the limit wraps, which makes it taller.
        // Twice, because a change of text is first laid out with the attributes of the old
        // markup, and that layout stays cached: a newly added ⌫ would measure at full size.
        row.clutter_text.set_markup(markup(restingItems(items)));
        row.clutter_text.set_markup(markup(restingItems(items)));
        row.set_size(-1, -1);
        const width = Math.min(row.get_preferred_width(-1)[1], maxWidth);
        const height = boxHeight(row.get_preferred_height(width)[1], this._lineHeight, this._paddingV);
        row.set_size(width, height);
        entry.size = {width, height};

        row.clutter_text.set_markup(markup(items));
    }
}
