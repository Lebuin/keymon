// Draws the runs from the display state as click-through rows in the top chrome.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {drawShadow, SHADOW_MARGIN} from './boxshadow.js';
import { boxHeight, enteringPivot, enteringY, placeRows, restingItems, runItems, textMarkup } from './layout.js';

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

const FADE_PX = 24;

// Fades in from nothing at the left edge, over the fraction of the width in fade. Colours
// here are premultiplied, so all four channels scale together.
const FADE_SHADER = `
uniform sampler2D tex;
uniform float fade;
void main() {
    vec4 color = texture2D(tex, cogl_tex_coord_in[0].st);
    cogl_color_out = color * cogl_color_in.a * clamp(cogl_tex_coord_in[0].s / fade, 0.0, 1.0);
}`;

export class KeyOverlay {
    // guard(callback) runs what this class starts by itself, outside render().
    constructor(config, guard) {
        this._config = config;
        this._guard = guard;
        this._slideId = 0; // The wait for a row to finish sliding in.
        this._stack = []; // Newest first: {id, row, shadow, sheen, clip, label, fade, size, fading, targetY}.
        this._colors = {
            held: pangoColor(config.text.held_color),
            muted: pangoColor(config.text.muted_color),
        };
        const radius = `border-radius: ${config.box.corner_radius}px;`;
        this._boxStyle = `background-color: ${config.box.background};${radius}`;
        // Lit from above: a soft shadow below, a dark edge to stay crisp on light
        // backgrounds, and on top a faint sheen with a bright line along the upper edge.
        this._sheenStyle = null;
        if (config.box.depth) {
            this._boxStyle += 'border: 1px solid rgba(0,0,0,0.5);';
            this._sheenStyle = `${radius}` +
                'background-gradient-direction: vertical;' +
                'background-gradient-start: rgba(255,255,255,0.12);' +
                'background-gradient-end: rgba(255,255,255,0.01);' +
                'box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);';
        }
        this._textStyle =
            `font-family: ${config.text.font}; font-weight: ${config.text.weight};` +
            `font-size: ${config.text.size}px;` +
            `color: ${config.text.color};`;

        this._root = new St.Widget({reactive: false, can_focus: false, track_hover: false});
        Main.layoutManager.addTopChrome(this._root, {affectsInputRegion: false});
        this._measureLine();
    }

    // Extra line height also goes above and below the line, so the padding gives that
    // back to keep the configured space around the text.
    _measureLine() {
        const probe = new St.Label({text: 'x', style: this._textStyle});
        this._root.add_child(probe);
        const line = probe.get_preferred_height(-1)[1];
        probe.destroy();

        this._lineHeight = line * this._config.text.line_height;
        const extra = (this._lineHeight - line) / 2;
        this._paddingV = Math.max(Math.round(this._config.box.padding_v - extra), 0);
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

    // A box, with a clipped layer the size of the box holding the text. The layer can
    // fade without affecting the background.
    _makeEntry(run, maxWidth) {
        const inert = {reactive: false, can_focus: false, track_hover: false};
        const row = new St.Widget({...inert, style: this._boxStyle});
        // Its own actor, so that the area it covers is redrawn when the box goes.
        const shadow = new St.DrawingArea({...inert, visible: this._config.box.depth});
        shadow.connect('repaint', area => {
            const cr = area.get_context();
            drawShadow(cr, row.width, row.height, this._config.box.corner_radius);
            cr.$dispose();
        });
        shadow.set_position(-SHADOW_MARGIN, -SHADOW_MARGIN);
        row.add_child(shadow);
        const sheen = new St.Widget({...inert, style: this._sheenStyle, visible: this._sheenStyle !== null});
        row.add_child(sheen);
        const clip = new St.Widget({...inert, clip_to_allocation: true});
        const label = new St.Label({...inert, style: this._textStyle});
        label.clutter_text.set({line_wrap: false, ellipsize: Pango.EllipsizeMode.NONE});
        clip.add_child(label);
        row.add_child(clip);
        this._root.add_child(row);

        const fade = new Clutter.ShaderEffect({shader_type: Clutter.ShaderType.FRAGMENT_SHADER});
        fade.set_shader_source(FADE_SHADER);
        fade.set_uniform_value('tex', 0);
        fade.enabled = false;
        clip.add_effect(fade);

        const entry = {id: run.id, row, shadow, sheen, clip, label, fade, size: null, fading: false, targetY: null};
        this._updateEntry(entry, run, maxWidth);
        return entry;
    }

    _updateEntry(entry, run, maxWidth) {
        const {row, shadow, sheen, clip, label, fade} = entry;
        const {padding_h: paddingH} = this._config.box;
        const items = runItems(run);
        const markup = shown => textMarkup(shown, this._colors, this._config.text.size, this._lineHeight);

        // Twice, because a change of text is first laid out with the attributes of the old
        // markup, and that layout stays cached: a newly added ⌫ would measure at full size.
        label.clutter_text.set_markup(markup(restingItems(items)));
        label.clutter_text.set_markup(markup(restingItems(items)));
        const textWidth = label.get_preferred_width(-1)[1];

        const width = Math.min(textWidth + 2 * paddingH, maxWidth);
        const height = boxHeight(this._lineHeight, this._paddingV);
        row.set_size(width, height);
        shadow.set_size(width + 2 * SHADOW_MARGIN, height + 2 * SHADOW_MARGIN);
        shadow.queue_repaint();
        sheen.set_size(width, height);
        clip.set_size(width, height);
        entry.size = {width, height};

        // A box too narrow for its text keeps the end of it, and the start fades out.
        label.set_position(width - paddingH - textWidth, this._paddingV);
        fade.enabled = textWidth + 2 * paddingH > maxWidth;
        fade.set_uniform_value('fade', FADE_PX / width);

        label.clutter_text.set_markup(markup(items));
    }
}
