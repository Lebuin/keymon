// Runs keymon-keymap, and turns key codes into keymap table entries. It has no
// Shell imports, so that it can be tested under plain gjs.

import Gio from 'gi://Gio';

// The index of an entry in the table is a combination of these bits.
const SHIFT = 1;
const ALTGR = 2;
const CAPS = 4;
const NUM = 8;

const SOFT_MODIFIER_BITS = {
    Shift_L: SHIFT,
    Shift_R: SHIFT,
    ISO_Level3_Shift: ALTGR,
};

const XKB_KEYCODE_OFFSET = 8;

// Splits GNOME's "layout+variant" source id.
export function parseXkbId(xkbId) {
    const [layout, variant = ''] = xkbId.split('+');
    return {layout, variant};
}

// Resolves to the table for a layout, and rejects if the tool fails.
export function loadKeymap(toolPath, xkbId, options) {
    const {layout, variant} = parseXkbId(xkbId);
    const process = Gio.Subprocess.new(
        [toolPath, '--layout', layout, '--variant', variant, '--options', options.join(',')],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    return new Promise((resolve, reject) => {
        process.communicate_utf8_async(null, null, (source, result) => {
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (!source.get_successful())
                    throw new Error(stderr.trim() || `${toolPath} failed`);
                resolve(JSON.parse(stdout).keys);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class KeyResolver {
    constructor() {
        this._table = {};
        this.reset();
    }

    // Applies to the next key press.
    setTable(table) {
        this._table = table;
    }

    reset() {
        this._held = new Map(); // Key code to {bit, count}.
    }

    // Returns the entry for a press, under the Shift and AltGr held so far and
    // the given lock state. Release matches by key code, so a layout switch
    // while a modifier is held doesn't leave it stuck.
    keyDown(code, {capsLock, numLock}) {
        let bits = capsLock ? CAPS : 0;
        bits |= numLock ? NUM : 0;
        for (const {bit} of this._held.values())
            bits |= bit;

        const key = this._table[code + XKB_KEYCODE_OFFSET]?.[bits] ??
            {keysym: `Key${code}`, text: null, class: 'special'};

        const held = this._held.get(code);
        if (held)
            held.count++; // The same key on a second keyboard.
        else
            this._held.set(code, {bit: SOFT_MODIFIER_BITS[key.keysym] ?? 0, count: 1});
        return key;
    }

    keyUp(code) {
        const held = this._held.get(code);
        if (held && --held.count === 0)
            this._held.delete(code);
    }
}
