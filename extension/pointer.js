// Draws the permanent ring around the pointer and a ripple for each mouse press, as
// click-through actors in the top chrome. Polled once per frame, on the frame clock
// of the monitor the ring is on.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ButtonTracker} from './buttons.js';

const EASING = {
    'linear': Clutter.AnimationMode.LINEAR,
    'ease-in': Clutter.AnimationMode.EASE_IN_QUAD,
    'ease-out': Clutter.AnimationMode.EASE_OUT_QUAD,
    'ease-in-out': Clutter.AnimationMode.EASE_IN_OUT_QUAD,
};

export class PointerDisplay {
    // onPress runs once per frame in which a tracked button went down, and
    // guard(callback) runs each frame.
    constructor(config, onPress, guard) {
        this._config = config;
        this._onPress = onPress;
        this._held = new Map(); // Button name to the ripple it holds up.
        this._lastX = this._lastY = null;
        this._buttons = new ButtonTracker(global.get_pointer()[2]);

        // Added first, so that ripples are drawn under the ring.
        this._ripples = new St.Widget({reactive: false, can_focus: false, track_hover: false});
        Main.layoutManager.addTopChrome(this._ripples, {affectsInputRegion: false});

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

        Main.layoutManager.removeChrome(this._ripples);
        this._ripples.destroy();
        this._ripples = null;
        this._held.clear();
    }

    _onFrame() {
        const [x, y, modifiers] = global.get_pointer();
        const {radius} = this._config.ring;
        if (x !== this._lastX || y !== this._lastY) {
            this._lastX = x;
            this._lastY = y;
            this._ring.set_position(x - radius, y - radius);
            for (const ripple of this._held.values())
                ripple.set_position(x - radius, y - radius);
        }

        const {pressed, released} = this._buttons.update(modifiers);
        for (const button of released)
            this._release(button);
        for (const button of pressed)
            this._held.set(button, this._makeRipple(button, x - radius, y - radius));
        if (pressed.length > 0)
            this._onPress();
    }

    // A disc at the ring's full size, scaled up from nothing. It keeps its opacity
    // until its button is released, so a click's growth and fade run almost together.
    _makeRipple(button, x, y) {
        const {radius} = this._config.ring;
        const {start_opacity: startOpacity, duration_ms: duration, easing} = this._config.ripple;
        const ripple = new St.Widget({
            reactive: false,
            can_focus: false,
            track_hover: false,
            x,
            y,
            width: radius * 2,
            height: radius * 2,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            scale_x: 0,
            scale_y: 0,
            opacity: Math.round(startOpacity * 255),
            style: `background-color: ${this._config.colors[button]}; border-radius: ${radius}px;`,
        });
        this._ripples.add_child(ripple);
        ripple.ease({scale_x: 1, scale_y: 1, duration, mode: EASING[easing]});
        return ripple;
    }

    // Stays where the pointer is now, and finishes growing if it hasn't yet.
    _release(button) {
        const ripple = this._held.get(button);
        if (!ripple)
            return;
        this._held.delete(button);
        const {duration_ms: duration, easing} = this._config.ripple;
        ripple.ease({
            opacity: 0,
            duration,
            mode: EASING[easing],
            onComplete: () => ripple.destroy(),
        });
    }
}
