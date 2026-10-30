// Turns the button bits of a pointer state into press and release transitions. It
// has no Shell imports, so that it can be tested under plain gjs.

// Clutter.ModifierType.BUTTON1_MASK to BUTTON3_MASK. Back, forward and other side
// buttons have no bit here, so they are ignored.
const BUTTONS = [
    {name: 'left', mask: 1 << 8},
    {name: 'middle', mask: 1 << 9},
    {name: 'right', mask: 1 << 10},
];

export class ButtonTracker {
    // A button already down at the start is not a press, and its release does nothing
    // for the caller, who has seen no press for it.
    constructor(modifiers) {
        this._last = modifiers;
    }

    // Returns the names of the buttons that went down and up since the last call.
    update(modifiers) {
        const changed = modifiers ^ this._last;
        this._last = modifiers;
        const names = bits => BUTTONS.filter(({mask}) => changed & bits & mask).map(({name}) => name);
        return {pressed: names(modifiers), released: names(~modifiers)};
    }
}
