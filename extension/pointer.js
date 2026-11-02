// Draws the permanent ring around the pointer and a small mouse drawing for each mouse
// press, or a ripple for a left press if the config asks for it, as click-through actors in the top chrome. Polled once per frame, on the frame
// clock of the monitor the ring is on.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ButtonTracker} from './buttons.js';
import {drawMouse} from './mousedrawing.js';

const EASING = {
    'linear': Clutter.AnimationMode.LINEAR,
    'ease-in': Clutter.AnimationMode.EASE_IN_QUAD,
    'ease-out': Clutter.AnimationMode.EASE_OUT_QUAD,
    'ease-in-out': Clutter.AnimationMode.EASE_IN_OUT_QUAD,
};

function cairoColor(css) {
    const {red, green, blue, alpha} = Clutter.Color.from_string(css)[1];
    return [red / 255, green / 255, blue / 255, alpha / 255];
}

export class PointerDisplay {
    // onPress runs once per frame in which a tracked button went down, and
    // guard(callback) runs each frame.
    constructor(config, onPress, guard) {
        this._config = config;
        this._onPress = onPress;
        this._held = new Map(); // Button name to the drawing it holds up.
        this._appearing = new Set(); // Drawings and ripples not yet done appearing and holding.
        this._holds = new Set(); // Timeouts of those holding.
        this._guard = guard;
        this._lastX = this._lastY = null;
        this._buttons = new ButtonTracker(global.get_pointer()[2]);

        // Added first, so that drawings are drawn under the ring.
        this._drawings = new St.Widget({reactive: false, can_focus: false, track_hover: false});
        Main.layoutManager.addTopChrome(this._drawings, {affectsInputRegion: false});

        const {radius, stroke_width: strokeWidth, stroke_color: strokeColor, fill_color: fillColor} = config.ring;
        this._ring = new St.Widget({
            reactive: false,
            can_focus: false,
            track_hover: false,
            width: radius * 2,
            height: radius * 2,
            style: `border: ${strokeWidth}px solid ${strokeColor}; border-radius: ${radius}px;` +
                `background-color: ${fillColor};`,
        });
        Main.layoutManager.addTopChrome(this._ring, {affectsInputRegion: false});
        this._onFrame();

        this._timeline = new Clutter.Timeline({
            actor: this._ring,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => guard(() => this._onFrame()));
        this._timeline.start();
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;

        Main.layoutManager.removeChrome(this._ring);
        this._ring.destroy();
        this._ring = null;

        Main.layoutManager.removeChrome(this._drawings);
        this._drawings.destroy();
        this._drawings = null;
        this._held.clear();
        this._appearing.clear();
        for (const id of this._holds)
            GLib.source_remove(id);
        this._holds.clear();
    }

    _onFrame() {
        const [x, y, modifiers] = global.get_pointer();
        const {radius} = this._config.ring;
        if (x !== this._lastX || y !== this._lastY) {
            this._lastX = x;
            this._lastY = y;
            this._ring.set_position(x - radius, y - radius);
            // Held or fading, they all stay with the pointer.
            for (const drawing of this._drawings.get_children())
                drawing.set_position(x - radius, y - radius);
        }

        const {pressed, released} = this._buttons.update(modifiers);
        for (const button of released)
            this._release(button);
        for (const button of pressed) {
            if (button === 'left' && this._config.click.left_style === 'ripple')
                this._startRipple(x - radius, y - radius);
            else
                this._startDrawing(button, x - radius, y - radius);
        }
        if (pressed.length > 0)
            this._onPress();
    }

    _startDrawing(button, x, y) {
        const drawing = this._makeDrawing(button, x, y);
        this._drawings.add_child(drawing);
        this._held.set(button, drawing);
        this._fadeIn(drawing);
    }

    // A disc filling the inside of the ring, scaled up from nothing while it fades in. It
    // finishes growing even if the button is already up, and only then fades out. Its holder has the ring's
    // size, so that it moves like a drawing. The disc stops at the ring's stroke, so that
    // translucent colours don't double up.
    _startRipple(x, y) {
        const {radius, stroke_width: strokeWidth} = this._config.ring;
        const {fill_color: fillColor, duration_ms: duration, easing} = this._config.click;
        const inert = {reactive: false, can_focus: false, track_hover: false};
        const ripple = new St.Widget({...inert, x, y, width: radius * 2, height: radius * 2, opacity: 0});
        const inner = Math.max(radius - strokeWidth, 0);
        const disc = new St.Widget({
            ...inert,
            x: radius - inner,
            y: radius - inner,
            width: inner * 2,
            height: inner * 2,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            scale_x: 0,
            scale_y: 0,
            style: `background-color: ${fillColor}; border-radius: ${inner}px;`,
        });
        ripple.add_child(disc);
        this._drawings.add_child(ripple);
        this._held.set('left', ripple);
        this._appearing.add(ripple);
        ripple.ease({opacity: 255, duration, mode: EASING[easing]});
        disc.ease({
            scale_x: 1,
            scale_y: 1,
            duration,
            mode: EASING[easing],
            onComplete: () => this._hold(ripple),
        });
    }

    // A mouse with this button filled in. Its lines take the ring's colour.
    _makeDrawing(button, x, y) {
        const {radius, stroke_width: strokeWidth, stroke_color: strokeColor} = this._config.ring;
        const fill = cairoColor(this._config.click.fill_color);
        const line = cairoColor(strokeColor);
        const drawing = new St.DrawingArea({
            reactive: false,
            can_focus: false,
            track_hover: false,
            x,
            y,
            width: radius * 2,
            height: radius * 2,
            opacity: 0,
        });
        drawing.connect('repaint', area => {
            const cr = area.get_context();
            drawMouse(cr, radius, strokeWidth, button, fill, line);
            cr.$dispose();
        });
        return drawing;
    }

    // Finishes appearing even if the button is already up, so a quick click still shows.
    _fadeIn(drawing) {
        const {duration_ms: duration, easing} = this._config.click;
        this._appearing.add(drawing);
        drawing.ease({
            opacity: 255,
            duration,
            mode: EASING[easing],
            onComplete: () => this._hold(drawing),
        });
    }

    // Stays at full opacity for a moment, even if the button is already up.
    _hold(drawing) {
        const done = () => {
            this._appearing.delete(drawing);
            if (![...this._held.values()].includes(drawing))
                this._fadeOut(drawing);
        };
        const {hold_ms: hold} = this._config.click;
        if (hold <= 0) {
            done();
            return;
        }
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hold, () => {
            this._holds.delete(id);
            this._guard(done);
            return GLib.SOURCE_REMOVE;
        });
        this._holds.add(id);
    }

    _fadeOut(drawing) {
        const {duration_ms: duration, easing} = this._config.click;
        drawing.ease({
            opacity: 0,
            duration,
            mode: EASING[easing],
            onComplete: () => drawing.destroy(),
        });
    }

    _release(button) {
        const drawing = this._held.get(button);
        if (!drawing)
            return;
        this._held.delete(button);
        if (!this._appearing.has(drawing))
            this._fadeOut(drawing);
    }
}
