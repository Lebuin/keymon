// Draws a zoomed-in mouse that fits inside the ring, with one button filled in: the
// ring is the mouse's outline, a line runs up from the bottom to about a third of the way,
// and the scroll wheel runs on from there to the top. It has no Shell imports, so that
// it can be tested under plain gjs.

const WHEEL_BOTTOM = 0.65; // As a fraction of the ring's height, from the top.
const WHEEL_WIDTH = 0.22; // As a fraction of the ring's height.
const LINE_WIDTH = 2;

// cr is a Cairo context for a square of radius * 2, and ringWidth is the stroke of the
// ring drawn over it. button is 'left', 'middle', or 'right', and fill and line are
// [red, green, blue, alpha] from 0 to 1. All of these can be translucent, so the fill,
// the lines, and the ring each stop where the next one starts.
export function drawMouse(cr, radius, ringWidth, button, fill, line) {
    const size = radius * 2;
    const center = Math.round(radius);
    const wheelRadius = Math.round(radius * WHEEL_WIDTH);
    const wheelBottom = Math.round(size * WHEEL_BOTTOM);
    const wheelArcY = wheelBottom - wheelRadius;
    const halfLine = LINE_WIDTH / 2;

    cr.arc(radius, radius, Math.max(radius - ringWidth, 0), 0, 2 * Math.PI);
    cr.clip();

    cr.setSourceRGBA(...fill);
    if (button === 'middle') {
        const inner = wheelRadius - halfLine;
        cr.moveTo(center - inner, 0);
        cr.arcNegative(center, wheelArcY, inner, Math.PI, 0);
        cr.lineTo(center + inner, 0);
    } else {
        // The outside of the wheel's outline, from where it meets the line below it.
        const outer = wheelRadius + halfLine;
        const meetY = Math.sqrt(outer * outer - halfLine * halfLine);
        const meetAngle = Math.atan2(meetY, halfLine);
        if (button === 'left') {
            cr.moveTo(center - halfLine, size);
            cr.lineTo(center - halfLine, wheelArcY + meetY);
            cr.arc(center, wheelArcY, outer, Math.PI - meetAngle, Math.PI);
            cr.lineTo(center - outer, 0);
            cr.lineTo(0, 0);
            cr.lineTo(0, size);
        } else {
            cr.moveTo(center + halfLine, size);
            cr.lineTo(center + halfLine, wheelArcY + meetY);
            cr.arcNegative(center, wheelArcY, outer, meetAngle, 0);
            cr.lineTo(center + outer, 0);
            cr.lineTo(size, 0);
            cr.lineTo(size, size);
        }
    }
    cr.closePath();
    cr.fill();

    // One stroke, so that the line and the wheel don't double up where they join.
    cr.setSourceRGBA(...line);
    cr.setLineWidth(LINE_WIDTH);
    cr.moveTo(center, size);
    cr.lineTo(center, wheelBottom);
    cr.moveTo(center - wheelRadius, 0);
    cr.arcNegative(center, wheelArcY, wheelRadius, Math.PI, 0);
    cr.lineTo(center + wheelRadius, 0);
    cr.stroke();
}
