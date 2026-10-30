// Reads config.json, with the defaults from SPEC.md section 11. Live reload and
// validation come in stage 6, so for now it is read at each switch-on.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { DEFAULT_KEYS } from './state.js';

const DEFAULTS = {
    toggle_shortcut: '<Super><Alt>k',
    overlay: {
        monitor: 'primary',
        origin_h: 'center',
        origin_v: 'bottom',
        anchor_h: 'center',
        anchor_v: 'bottom',
        offset_x: 0,
        offset_y: -80,
        row_spacing: 8,
    },
    box: {
        background: 'rgba(0,0,0,0.75)',
        padding_h: 16,
        padding_v: 8,
        corner_radius: 12,
        fade_out_ms: 200,
        max_width: 800,
    },
    text: {
        color: '#ffffff',
        held_color: '#ffcc00',
        muted_color: 'rgba(255,255,255,0.8)',
        size: 28,
        font: 'sans',
        weight: 'normal',
    },
    keys: {
        ...DEFAULT_KEYS,
        stack_direction: 'up',
    },
};

export function readConfig() {
    const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'keymon', 'config.json']);
    let file = {};
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        file = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.log(`keymon: config not used: ${e.message}`);
    }
    return {
        toggle_shortcut: file.toggle_shortcut ?? DEFAULTS.toggle_shortcut,
        overlay: {...DEFAULTS.overlay, ...file.overlay},
        box: {...DEFAULTS.box, ...file.box},
        text: {...DEFAULTS.text, ...file.text},
        keys: {...DEFAULTS.keys, ...file.keys},
    };
}
