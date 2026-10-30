// Draws the soft shadow below a box. It has no Shell imports, so that it can be tested
// under plain gjs.

import Cairo from 'cairo';

const SPREAD = 4;
const OFFSET_Y = 1;
const LAYERS = 8;
const LAYER_ALPHA = 0.009;

// How far the shadow reaches past the box on every side.
export const SHADOW_MARGIN = SPREAD + OFFSET_Y;

function roundedRect(cr, x, y, width, height, radius) {
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// cr is a Cairo context for the box's size plus SHADOW_MARGIN on every side. Rounded
// rectangles are stacked from wide to narrow, closer together near the box, which falls
// off smoothly. Nothing is drawn under the box, so that it doesn't show through a
// translucent background.
export function drawShadow(cr, width, height, radius) {
    const margin = SHADOW_MARGIN;
    cr.setFillRule(Cairo.FillRule.EVEN_ODD);
    cr.rectangle(0, 0, width + 2 * margin, height + 2 * margin);
    roundedRect(cr, margin, margin, width, height, radius);
    cr.clip();
    cr.setFillRule(Cairo.FillRule.WINDING);

    cr.setSourceRGBA(0, 0, 0, LAYER_ALPHA);
    for (let i = 0; i < LAYERS; i++) {
        const grow = SPREAD * (1 - i / LAYERS) ** 1.5;
        roundedRect(cr, margin - grow, margin - grow + OFFSET_Y, width + 2 * grow, height + 2 * grow, radius + grow);
        cr.fill();
    }
}
