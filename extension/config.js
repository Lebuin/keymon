// Reads, validates and watches config.json, with the defaults from SPEC.md section
// 11. It has no Shell imports, so that it can be tested under plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { DEFAULT_KEYS } from './state.js';

export const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'keymon', 'config.json']);

// An editor's save can take several writes, and a half-written file isn't an error.
const SETTLE_MS = 200;

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
        background: 'rgba(0,0,0,0.8)',
        padding_h: 16,
        padding_v: 8,
        corner_radius: 12,
        animation_ms: 150,
        enter_scale: 0,
        animate_first: false,
        max_width: 800,
    },
    text: {
        color: '#ffffff',
        held_color: '#ffcc00',
        muted_color: 'rgba(255,255,255,0.8)',
        size: 28,
        font: 'sans',
        weight: 'normal',
        line_height: 1.25,
    },
    keys: {
        ...DEFAULT_KEYS,
        stack_direction: 'up',
    },
    mouse: {
        ring: {
            radius: 28,
            stroke_width: 3,
            stroke_color: '#ffcc00',
            fill_color: 'rgba(0,0,0,0)',
        },
        click: {
            fill_color: 'rgba(255,204,0,0.8)',
            duration_ms: 150,
            left_style: 'drawing',
            ripple_duration_ms: 300,
            easing: 'ease-out',
        },
    },
};

// Missing keys take their default, at every level of the file.
export function mergeConfig(file) {
    return {
        toggle_shortcut: file.toggle_shortcut ?? DEFAULTS.toggle_shortcut,
        overlay: {...DEFAULTS.overlay, ...file.overlay},
        box: {...DEFAULTS.box, ...file.box},
        text: {...DEFAULTS.text, ...file.text},
        keys: {...DEFAULTS.keys, ...file.keys},
        mouse: {
            ring: {...DEFAULTS.mouse.ring, ...file.mouse?.ring},
            click: {...DEFAULTS.mouse.click, ...file.mouse?.click},
        },
    };
}

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const isSize = value => isNumber(value) && value >= 0;
const isPositive = value => isNumber(value) && value > 0;
const isText = value => typeof value === 'string' && value !== '';
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isOneOf = (...options) => value => options.includes(value);
const orNull = rule => value => value === null || rule(value);

const SIZE = [isSize, 'a number of 0 or more'];
const POSITIVE = [isPositive, 'a number above 0'];
const TEXT = [isText, 'a non-empty string'];
const COLOR = 'color';
const COLOR_OR_NULL = 'color or null';
const H_POINT = [isOneOf('left', 'center', 'right'), 'left, center, or right'];
const V_POINT = [isOneOf('top', 'center', 'bottom'), 'top, center, or bottom'];

const SECTIONS = ['overlay', 'box', 'text', 'keys', 'keys.names', 'mouse', 'mouse.ring', 'mouse.click'];

const RULES = {
    'toggle_shortcut': [value => isText(value) && /^(<\w+>)*[^<>\s]+$/.test(value), 'a shortcut such as <Super><Alt>k'],
    'overlay.monitor': TEXT,
    'overlay.origin_h': H_POINT,
    'overlay.origin_v': V_POINT,
    'overlay.anchor_h': H_POINT,
    'overlay.anchor_v': V_POINT,
    'overlay.offset_x': [isNumber, 'a number'],
    'overlay.offset_y': [isNumber, 'a number'],
    'overlay.row_spacing': SIZE,
    'box.background': COLOR,
    'box.padding_h': SIZE,
    'box.padding_v': SIZE,
    'box.corner_radius': SIZE,
    'box.animation_ms': SIZE,
    'box.animate_first': [value => typeof value === 'boolean', 'true or false'],
    'box.enter_scale': [value => isNumber(value) && value >= 0 && value <= 1, 'a number from 0 to 1'],
    'box.max_width': POSITIVE,
    'text.color': COLOR,
    'text.held_color': COLOR_OR_NULL,
    'text.muted_color': COLOR_OR_NULL,
    'text.size': POSITIVE,
    'text.font': TEXT,
    'text.weight': [value => value === 'normal' || value === 'bold' || (isNumber(value) && value >= 100 && value <= 900),
        'normal, bold, or a number from 100 to 900'],
    'text.line_height': POSITIVE,
    'keys.run_visible_ms': POSITIVE,
    'keys.run_gap_ms': SIZE,
    'keys.repeat_delay_ms': [orNull(isSize), 'a number of 0 or more, or null'],
    'keys.repeat_interval_ms': [orNull(isPositive), 'a number above 0, or null'],
    'keys.shift_delay_ms': SIZE,
    'keys.max_runs': [value => Number.isInteger(value) && value >= 1, 'a whole number of 1 or more'],
    'keys.stack_direction': [isOneOf('up', 'down'), 'up or down'],
    'keys.space_symbol': TEXT,
    'mouse.ring.radius': POSITIVE,
    'mouse.ring.stroke_width': SIZE,
    'mouse.ring.stroke_color': COLOR,
    'mouse.ring.fill_color': COLOR,
    'mouse.click.fill_color': COLOR,
    'mouse.click.duration_ms': SIZE,
    'mouse.click.left_style': [isOneOf('drawing', 'ripple'), 'drawing or ripple'],
    'mouse.click.ripple_duration_ms': SIZE,
    'mouse.click.easing': [isOneOf('linear', 'ease-in', 'ease-out', 'ease-in-out'), 'linear, ease-in, ease-out, or ease-in-out'],
};

function lookUp(object, path) {
    return path.split('.').reduce((part, name) => part?.[name], object);
}

// Returns a message naming the first problem, or null. isColor(css) comes from the
// caller, since parsing a colour needs Clutter, which plain gjs doesn't have.
export function validateConfig(file, isColor) {
    if (!isObject(file))
        return 'the file must hold a JSON object';
    for (const section of SECTIONS) {
        const value = lookUp(file, section);
        if (value !== undefined && !isObject(value))
            return `${section} must be an object`;
    }
    for (const [name, label] of Object.entries(file.keys?.names ?? {})) {
        if (typeof label !== 'string')
            return `keys.names.${name} must be a string`;
    }

    const merged = mergeConfig(file);
    const isColorText = value => typeof value === 'string' && isColor(value);
    for (const [path, rule] of Object.entries(RULES)) {
        const value = lookUp(merged, path);
        let check, wanted;
        if (rule === COLOR)
            [check, wanted] = [isColorText, 'a colour'];
        else if (rule === COLOR_OR_NULL)
            [check, wanted] = [orNull(isColorText), 'a colour or null'];
        else
            [check, wanted] = rule;
        if (!check(value))
            return `${path} must be ${wanted}, not ${JSON.stringify(value)}`;
    }
    return null;
}

// Gives every colour the form colorToCss makes of it, since St's CSS parser takes
// fewer forms than the parser that validated them.
function normalizeColors(config, colorToCss) {
    for (const [path, rule] of Object.entries(RULES)) {
        if (rule !== COLOR && rule !== COLOR_OR_NULL)
            continue;
        const names = path.split('.');
        const name = names.pop();
        const section = names.reduce((part, key) => part[key], config);
        if (section[name] !== null)
            section[name] = colorToCss(section[name]);
    }
    return config;
}

// Returns {config} for a usable file, including a missing one, and otherwise
// {error} with a message naming the problem. colorToCss(css) returns a colour in the
// form St can read, or null if it isn't a colour.
export function readConfig(path, colorToCss) {
    let file = {};
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        file = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return {error: e.message};
    }
    const error = validateConfig(file, css => colorToCss(css) !== null);
    return error ? {error} : {config: normalizeColors(mergeConfig(file), colorToCss)};
}

// Runs onChange once a change to the file has settled, including the file being
// created, replaced, or removed.
export class ConfigWatcher {
    constructor(path, onChange) {
        this._onChange = onChange;
        this._timeoutId = 0;
        this._monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_monitor, _file, _other, event) => {
            if (event !== Gio.FileMonitorEvent.ATTRIBUTE_CHANGED)
                this._settle();
        });
    }

    destroy() {
        this._monitor.cancel();
        this._monitor = null;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    _settle() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._timeoutId = 0;
            this._onChange();
            return GLib.SOURCE_REMOVE;
        });
    }
}
