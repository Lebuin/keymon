// Row placement and text markup for the overlay. It has no Shell imports, so that
// it can be tested under plain gjs.

import GLib from 'gi://GLib';

const FRACTION = {left: 0, top: 0, center: 0.5, right: 1, bottom: 1};

// Places rows, newest first, on a monitor. sizes is [{width, height}], and
// overlay and direction are the overlay config and keys.stack_direction. The
// origin is a point on the monitor, the offset moves on from there, and the
// newest row's anchor point goes on the result. Returns
// [{x, y}] for the rows that fit. The newest row is always included.
export function placeRows(monitor, sizes, overlay, direction) {
    const anchorH = FRACTION[overlay.anchor_h];
    const anchorV = FRACTION[overlay.anchor_v];
    const pointX = monitor.x + monitor.width * FRACTION[overlay.origin_h] + overlay.offset_x;
    const pointY = monitor.y + monitor.height * FRACTION[overlay.origin_v] + overlay.offset_y;

    const positions = [];
    let y = 0;
    for (const [index, {width, height}] of sizes.entries()) {
        if (index === 0)
            y = pointY - height * anchorV;
        else if (direction === 'up')
            y -= height + overlay.row_spacing;
        else
            y += sizes[index - 1].height + overlay.row_spacing;

        if (index > 0 && (y < monitor.y || y + height > monitor.y + monitor.height))
            break;
        positions.push({x: Math.round(pointX - width * anchorH), y: Math.round(y)});
    }
    return positions;
}

// Fonts draw this symbol much larger than the text around it. Clutter ignores
// relative sizes in markup, so it gets an absolute size, in 1024ths of a point.
const OVERSIZED_SYMBOLS = {'⌫': 0.7};
const PANGO_UNITS_PER_PX = 1024 * 72 / 96;
// An absolute line height isn't in points, despite what Pango's documentation says.
const PANGO_UNITS_PER_ABSOLUTE_PX = 1024;

// The pieces of text in a run's one box. Modifier run parts are joined by a plus.
export function runItems(run) {
    if (run.kind === 'text')
        return run.items;
    return run.parts.flatMap(({label, held}, index) => [
        ...(index > 0 ? [{text: '+', held: false, muted: true}] : []),
        {text: label, held, muted: true},
    ]);
}

// Pango markup for a box's items. colors holds Pango colours for held and muted
// items, and either can be null to leave those in the box's normal colour. Clutter
// ignores a colour that starts at the first byte of the text, so a word joiner goes
// in front. A zero-width space would let a long word wrap past an empty first line.
// When a box wraps, word joiners keep each item whole, zero-width
// spaces allow a break after breakAfter items, and no hyphen appears at a break.
// lineHeight is in px. A factor would scale the tallest font on the line, so a symbol
// from a taller fallback font would make the box bigger.
export function textMarkup(items, colors, textSize, lineHeight) {
    const content = items.map(({text, held, muted, breakAfter}) => {
        const whole = [...text].join('\u2060');
        const escaped = text in OVERSIZED_SYMBOLS
            ? `<span size="${Math.round(textSize * OVERSIZED_SYMBOLS[text] * PANGO_UNITS_PER_PX)}">${text}</span>`
            : GLib.markup_escape_text(whole, -1);
        const color = (held && colors.held) || (muted && colors.muted);
        const span = color ? `<span foreground="${color}">${escaped}</span>` : escaped;
        return breakAfter ? `${span}\u200b` : span;
    }).join('');
    return `<span insert_hyphens="false" line_height="${Math.round(lineHeight * PANGO_UNITS_PER_ABSOLUTE_PX)}">\u2060${content}</span>`;
}
