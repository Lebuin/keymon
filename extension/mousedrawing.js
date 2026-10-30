// Draws a zoomed-in mouse that fits inside the ring, with one button filled in: the
// ring is the mouse's outline, a line runs up from the bottom to about a third of the way,
// and the scroll wheel runs on from there to the top. It has no Shell imports, so that
// it can be tested under plain gjs.

const WHEEL_BOTTOM = 0.65; // As a fraction of the ring's height, from the top.
const WHEEL_WIDTH = 0.22; // As a fraction of the ring's height.
const LINE_WIDTH = 1;

// cr is a Cairo context for a square of radius * 2. button is 'left', 'middle', or 'right', and
// fill and line are [red, green, blue, alpha] from 0 to 1.
export function drawMouse(cr, radius, button, fill, line) {
    const size = radius * 2;
    // Half a pixel off the true centre, so that 1 px lines land on whole pixels.
    const center = Math.floor(radius) + 0.5;
    const wheelRadius = Math.round(radius * WHEEL_WIDTH);
    const wheelBottom = Math.round(size * WHEEL_BOTTOM);
    const wheelArcY = wheelBottom - wheelRadius;

    cr.arc(radius, radius, radius, 0, 2 * Math.PI);
    cr.clip();

    cr.setSourceRGBA(...fill);
    if (button === 'left') {
        cr.moveTo(center, size);
        cr.lineTo(center, wheelBottom);
        cr.arc(center, wheelArcY, wheelRadius, Math.PI / 2, Math.PI);
        cr.lineTo(center - wheelRadius, 0);
        cr.lineTo(0, 0);
        cr.lineTo(0, size);
    } else if (button === 'right') {
        cr.moveTo(center, size);
        cr.lineTo(center, wheelBottom);
        cr.arcNegative(center, wheelArcY, wheelRadius, Math.PI / 2, 0);
        cr.lineTo(center + wheelRadius, 0);
        cr.lineTo(size, 0);
        cr.lineTo(size, size);
    } else {
        cr.moveTo(center - wheelRadius, 0);
        cr.arcNegative(center, wheelArcY, wheelRadius, Math.PI, 0);
        cr.lineTo(center + wheelRadius, 0);
    }
    cr.closePath();
    cr.fill();

    cr.setSourceRGBA(...line);
    cr.setLineWidth(LINE_WIDTH);
    cr.moveTo(center, size);
    cr.lineTo(center, wheelBottom);
    cr.stroke();
    cr.moveTo(center - wheelRadius, 0);
    cr.arcNegative(center, wheelArcY, wheelRadius, Math.PI, 0);
    cr.lineTo(center + wheelRadius, 0);
    cr.stroke();
}
