// The display state machine from SPEC.md section 7. It has no Shell imports and
// takes events and a clock as inputs, so that it can be tested under plain gjs.
//
// A key is an entry from the keymap table: {keysym, text, class}. It is looked
// up by the caller at press time, which is what locks its label.
//
// The caller renders runs() after every event, and calls tick() at the time
// nextDeadline() gives.

export const DEFAULT_KEYS = {
    run_visible_ms: 3000,
    run_gap_ms: 2000,
    shift_delay_ms: 200,
    repeat_delay_ms: null, // Null means keys don't repeat.
    max_runs: 5,
    space_symbol: '␣',
    names: {},
};

// Shift+Alt produces Meta on common layouts, and it is still the Alt key.
const MODIFIER_KEYSYMS = {
    Ctrl: ['Control_L', 'Control_R'],
    Alt: ['Alt_L', 'Alt_R', 'Meta_L', 'Meta_R'],
    AltGr: ['ISO_Level3_Shift'],
    Shift: ['Shift_L', 'Shift_R'],
    Super: ['Super_L', 'Super_R'],
};
const MODIFIER_ORDER = Object.keys(MODIFIER_KEYSYMS);
const SOFT_MODIFIERS = new Set(['AltGr', 'Shift']);
const MODIFIER_OF = {};
for (const [modifier, keysyms] of Object.entries(MODIFIER_KEYSYMS)) {
    for (const keysym of keysyms)
        MODIFIER_OF[keysym] = modifier;
}

// Shift+Tab produces ISO_Left_Tab, and the keypad's non-digit keysyms appear
// with Num Lock off.
const DEFAULT_NAMES = {
    Return: 'Enter', KP_Enter: 'Enter',
    Escape: 'Esc',
    Tab: 'Tab', ISO_Left_Tab: 'Tab',
    BackSpace: 'Backspace',
    Delete: 'Del', KP_Delete: 'Del',
    Left: '←', KP_Left: '←',
    Up: '↑', KP_Up: '↑',
    Right: '→', KP_Right: '→',
    Down: '↓', KP_Down: '↓',
    Prior: 'PgUp', KP_Prior: 'PgUp', Page_Up: 'PgUp', KP_Page_Up: 'PgUp',
    Next: 'PgDn', KP_Next: 'PgDn', Page_Down: 'PgDn', KP_Page_Down: 'PgDn',
    Home: 'Home', KP_Home: 'Home',
    End: 'End', KP_End: 'End',
    Insert: 'Ins', KP_Insert: 'Ins',
    Caps_Lock: 'Caps',
    space: 'Space',
};

const ENTER_KEYSYMS = new Set(['Return', 'KP_Enter']);
const TOKEN_GLYPHS = {
    Return: '⏎', KP_Enter: '⏎',
    BackSpace: '⌫',
    Tab: '⇥', ISO_Left_Tab: '⇥',
    Left: '←', KP_Left: '←',
    Up: '↑', KP_Up: '↑',
    Right: '→', KP_Right: '→',
    Down: '↓', KP_Down: '↓',
};

export class DisplayState {
    constructor(keys, now) {
        this._now = now;
        this._nextId = 1; // Never reused, since a fading row can outlive a reset.
        this.setConfig(keys);
        this.reset();
    }

    // Applies to keys pressed from now on. Labels already shown stay as they are.
    setConfig(keys) {
        this._keys = {...DEFAULT_KEYS, ...keys};
        this._limitRuns();
    }

    // Forgets everything, for when the helper disconnects or keymon switches off.
    reset() {
        this._runs = []; // Newest first.
        this._held = new Map(); // Key code to press.
        this._textRun = null; // The run that typing can still join.
        this._pending = new Set(); // Soft modifiers waiting for the delay.
        this._pendingDeadline = null;
        this._absorbed = new Set(); // Held soft modifiers that went into typing.
        this._inheritedId = null; // For the run replacing a row in place.
        this._repeat = null; // The key that may start repeating, as {press, at}.
    }

    keyDown(code, key) {
        this._advance();
        const existing = this._held.get(code);
        if (existing) {
            // The same key on a second keyboard.
            existing.count++;
            return;
        }
        const modifier = MODIFIER_OF[key.keysym] ?? null;
        const alreadyHeld = modifier !== null && this._modifierHeld(modifier);
        const press = {key, modifier, count: 1, run: null};
        const repeats = modifier === null && this._repeats(press);
        this._held.set(code, press);

        if (modifier !== null) {
            if (!alreadyHeld)
                this._modifierDown(modifier);
        } else if (key.class === 'printable') {
            this._printableDown(press);
        } else {
            this._specialDown(press);
        }
        if (modifier === null)
            this._startRepeat(repeats ? press : null);
        this._updateTimers();
    }

    keyUp(code) {
        this._advance();
        const press = this._held.get(code);
        if (!press)
            return;
        press.count--;
        if (press.count > 0)
            return;
        this._held.delete(code);
        if (this._repeat?.press === press)
            this._repeat = null;

        if (press.run !== null && press.run === this._textRun)
            press.run.lastActivity = this._now();
        if (press.modifier !== null && !this._modifierHeld(press.modifier)) {
            this._absorbed.delete(press.modifier);
            for (const run of this._runs) {
                for (const box of run.boxes ?? []) {
                    if (box.modifier === press.modifier)
                        box.live = false;
                }
            }
        }
        this._updateTimers();
    }

    mouseDown() {
        this._advance();
        if (this._pending.size > 0 || this._absorbed.size > 0)
            this._showModifiers([]);
        this._updateTimers();
    }

    tick() {
        this._advance();
    }

    // The time at which tick() next has work to do, or null if nothing is due.
    nextDeadline() {
        const deadlines = this._runs
            .filter(run => !run.paused)
            .map(run => run.timerStart + this._keys.run_visible_ms);
        if (this._pendingDeadline !== null)
            deadlines.push(this._pendingDeadline);
        if (this._repeat)
            deadlines.push(this._repeat.at);
        return deadlines.length > 0 ? Math.min(...deadlines) : null;
    }

    // For the overlay, when a row would leave the monitor. Returns whether a run
    // was removed. The newest run is never removed this way.
    dropOldest() {
        if (this._runs.length < 2)
            return false;
        this._runs.pop();
        return true;
    }

    // Newest first. A text run is {id, kind: 'text', items: [{text, held, muted, breakAfter}]},
    // and a modifier run is {id, kind: 'modifier', parts: [{label, held}]}. A run
    // keeps its id while shown, and a row replaced in place passes its id on.
    // A modifier only counts as held in the newest run.
    runs() {
        return this._runs.map((run, index) => (run.items
            ? this._textView(run)
            : this._modifierView(run, index === 0)));
    }

    _textView(run) {
        const items = run.items.map(item => ({
            text: item.text,
            held: this._isHeld(item.press),
            muted: item.muted,
            breakAfter: item.breakAfter,
        }));
        return {id: run.id, kind: 'text', items};
    }

    _modifierView(run, active) {
        const parts = [...run.boxes]
            .sort((a, b) => MODIFIER_ORDER.indexOf(a.modifier) - MODIFIER_ORDER.indexOf(b.modifier))
            .map(box => ({
                label: this._modifierLabel(box.modifier),
                held: active && this._modifierHeld(box.modifier),
            }));
        if (run.press)
            parts.push({label: run.label, held: this._isHeld(run.press)});
        return {id: run.id, kind: 'modifier', parts};
    }

    _modifierLabel(modifier) {
        const override = MODIFIER_KEYSYMS[modifier].find(keysym => keysym in this._keys.names);
        return override ? this._keys.names[override] : modifier;
    }

    _keyLabel(key) {
        const name = this._keys.names[key.keysym];
        if (name !== undefined)
            return name;
        if (key.keysym === 'space')
            return this._keys.space_symbol;
        if (key.class === 'printable')
            return key.text;
        return TOKEN_GLYPHS[key.keysym] ?? DEFAULT_NAMES[key.keysym] ?? key.keysym;
    }

    _isHeld(press) {
        return press !== null && press.count > 0;
    }

    _modifierHeld(modifier) {
        return [...this._held.values()].some(press => press.modifier === modifier);
    }

    _hardHeld() {
        return [...this._held.values()].some(
            press => press.modifier !== null && !SOFT_MODIFIERS.has(press.modifier));
    }

    _softHeld() {
        return [...this._held.values()].some(press => SOFT_MODIFIERS.has(press.modifier));
    }

    _heldModifiers() {
        return new Set([...this._held.values()]
            .map(press => press.modifier)
            .filter(modifier => modifier !== null));
    }

    _modifierDown(modifier) {
        if (this._pending.has(modifier))
            return;
        if (SOFT_MODIFIERS.has(modifier) && !this._hardHeld()) {
            // All pending modifiers resolve together, at the first one's deadline.
            this._pending.add(modifier);
            this._pendingDeadline ??= this._now() + this._keys.shift_delay_ms;
            return;
        }
        this._showModifiers([modifier]);
    }

    // Puts the newly shown modifiers, and any pending ones, into a modifier run.
    _showModifiers(extra) {
        const added = [...this._takePending(), ...extra];
        this._absorbed.clear();
        this._repeat = null;
        this._textRun = null;

        const newest = this._runs[0];
        if (newest?.boxes && !newest.press && newest.boxes.some(box => box.live)) {
            for (const modifier of added) {
                if (!newest.boxes.some(box => box.modifier === modifier))
                    newest.boxes.push(this._box(modifier));
            }
            if (added.length > 0)
                newest.timerStart = this._now();
            return;
        }
        this._addModifierRun(new Set([...this._heldModifiers(), ...added]), null);
    }

    _takePending() {
        const pending = [...this._pending];
        this._pending.clear();
        this._pendingDeadline = null;
        return pending;
    }

    _box(modifier) {
        return {modifier, live: this._modifierHeld(modifier)};
    }

    _addModifierRun(modifiers, press) {
        this._addRun({
            boxes: [...modifiers].map(modifier => this._box(modifier)),
            press,
            label: press ? this._keyLabel(press.key) : null,
        });
    }

    _addRun(run) {
        for (const older of this._runs)
            older.replaced = true;
        const id = this._inheritedId ?? this._nextId++;
        this._inheritedId = null;
        this._runs.unshift({...run, id, timerStart: this._now(), paused: false, replaced: false});
        this._limitRuns();
        return this._runs[0];
    }

    _limitRuns() {
        if (this._runs)
            this._runs.length = Math.min(this._runs.length, Math.max(this._keys.max_runs, 1));
    }

    _printableDown(press) {
        if (this._hardHeld()) {
            this._chord(press);
            return;
        }
        for (const modifier of this._takePending()) {
            if (this._modifierHeld(modifier))
                this._absorbed.add(modifier);
        }
        // A row of held soft modifiers gives way to the first character.
        const newest = this._runs[0];
        if (newest?.boxes && !newest.press &&
            newest.boxes.every(box => SOFT_MODIFIERS.has(box.modifier)) &&
            newest.boxes.some(box => box.live))
            this._inheritedId = this._runs.shift().id;

        this._appendTyped(press);
    }

    _appendTyped(press) {
        const text = press.key.keysym === 'space' ? this._keys.space_symbol : press.key.text;
        const muted = press.key.keysym === 'space';
        this._appendToText({text, token: false, muted, breakAfter: muted, press}, press);
    }

    _specialDown(press) {
        if (this._hardHeld() || this._softHeld() || this._pending.size > 0) {
            this._chord(press);
            return;
        }
        const {keysym} = press.key;
        if (keysym === 'BackSpace') {
            this._backspace(press);
            return;
        }
        const label = this._keys.names[keysym] ?? DEFAULT_NAMES[keysym] ?? keysym;
        const text = TOKEN_GLYPHS[keysym] ?? `‹${label}›`;
        this._appendToText({text, token: true, muted: true, press}, press);
        if (ENTER_KEYSYMS.has(keysym))
            this._textRun = null;
    }

    _backspace(press) {
        const run = this._currentTextRun();
        if (!run || run.items.at(-1).token || run.items.at(-1).repeated) {
            this._appendToText({text: '⌫', token: true, muted: true, press}, press);
            return;
        }
        run.items.pop();
        if (run.items.length === 0) {
            this._runs.splice(this._runs.indexOf(run), 1);
            this._textRun = null;
            return;
        }
        run.timerStart = run.lastActivity = this._now();
        press.run = run;
    }

    _chord(press) {
        const modifiers = new Set([...this._heldModifiers(), ...this._takePending()]);
        this._absorbed.clear();
        this._repeat = null;
        this._textRun = null;

        const newest = this._runs[0];
        if (newest?.boxes && !newest.press && newest.boxes.length === modifiers.size &&
            newest.boxes.every(box => modifiers.has(box.modifier))) {
            newest.press = press;
            newest.label = this._keyLabel(press.key);
            newest.timerStart = this._now();
            return;
        }
        this._addModifierRun(modifiers, press);
    }

    _currentTextRun() {
        const run = this._textRun;
        if (run && this._now() - run.lastActivity >= this._keys.run_gap_ms)
            this._textRun = null;
        return this._textRun;
    }

    _appendToText(item, press) {
        const run = this._currentTextRun() ?? this._addRun({items: []});
        this._textRun = run;
        run.items.push(item);
        run.timerStart = run.lastActivity = this._now();
        press.run = run;
    }

    // Only typed characters repeat in an application, as long as they aren't chorded.
    _repeats(press) {
        return press.key.class === 'printable' && !this._hardHeld();
    }

    _startRepeat(press) {
        const {repeat_delay_ms: delay} = this._keys;
        this._repeat = press && delay !== null ? {press, at: this._now() + delay} : null;
    }

    // A key held this long has typed more than the one character shown, so Backspace
    // can no longer erase it from the display.
    _markRepeated(now) {
        if (!this._repeat || now < this._repeat.at)
            return;
        const {press} = this._repeat;
        for (const item of press.run.items) {
            if (item.press === press)
                item.repeated = true;
        }
        this._repeat = null;
    }

    _runHeld(run) {
        if (run.items)
            return run.items.some(item => this._isHeld(item.press));
        return run.boxes.some(box => box.live) || this._isHeld(run.press);
    }

    // The newest run waits for its keys to be released. Being replaced as newest
    // ends the wait for good, and a timer already running just keeps going.
    _updateTimers() {
        for (const run of this._runs) {
            if (!run.replaced && this._runHeld(run)) {
                run.paused = true;
            } else if (run.paused) {
                run.paused = false;
                run.timerStart = this._now();
            }
        }
    }

    _advance() {
        const now = this._now();
        if (this._pendingDeadline !== null && now >= this._pendingDeadline)
            this._showModifiers([]);
        this._markRepeated(now);
        this._updateTimers();
        this._runs = this._runs.filter(
            run => run.paused || now - run.timerStart < this._keys.run_visible_ms);
        if (!this._runs.includes(this._textRun))
            this._textRun = null;
    }
}
