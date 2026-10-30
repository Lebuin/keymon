// Run with: gjs -m tests/test_pointer.js
//
// Covers the button transitions behind the ripples, and merging the mouse config.

import System from 'system';

import {ButtonTracker} from '../extension/buttons.js';
import {mergeConfig} from '../extension/config.js';

let failed = 0;

function eq(actual, expected, what) {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) {
        failed++;
        console.log(`FAIL ${what}: got ${a}, expected ${e}`);
    } else {
        console.log(`ok ${what}`);
    }
}

const LEFT = 1 << 8;
const MIDDLE = 1 << 10;
const RIGHT = 1 << 9;
const SHIFT = 1 << 0;
const BACK = 1 << 11; // Clutter's BUTTON4_MASK.
const NOTHING = {pressed: [], released: []};

function testButtons() {
    const tracker = new ButtonTracker(0);
    eq(tracker.update(0), NOTHING, 'no change gives nothing');
    eq(tracker.update(LEFT), {pressed: ['left'], released: []}, 'a press');
    eq(tracker.update(LEFT), NOTHING, 'a held button is pressed only once');
    eq(tracker.update(LEFT | RIGHT), {pressed: ['right'], released: []}, 'a second button');
    eq(tracker.update(RIGHT), {pressed: [], released: ['left']}, 'a release of one of two');
    eq(tracker.update(MIDDLE), {pressed: ['middle'], released: ['right']}, 'a press and a release at once');
    eq(tracker.update(0), {pressed: [], released: ['middle']}, 'the last release');
    eq(tracker.update(LEFT | MIDDLE | RIGHT), {pressed: ['left', 'middle', 'right'], released: []},
        'three presses in one frame');
    tracker.update(0);

    eq(tracker.update(SHIFT), NOTHING, 'a keyboard modifier is no button');
    eq(tracker.update(SHIFT | BACK), NOTHING, 'a side button is ignored');
    eq(tracker.update(0), NOTHING, 'and so are their releases');

    const started = new ButtonTracker(LEFT);
    eq(started.update(LEFT), NOTHING, 'a button down at the start is not a press');
    eq(started.update(0), {pressed: [], released: ['left']}, 'its release still shows');
    eq(started.update(LEFT), {pressed: ['left'], released: []}, 'and the next press counts');
}

function testConfig() {
    const defaults = mergeConfig({}).mouse;
    eq(defaults.ring, {radius: 28, stroke_width: 3, stroke_color: '#ffcc00', fill_color: 'rgba(0,0,0,0)'},
        'ring defaults');
    eq(defaults.colors, {left: '#ffcc00', middle: '#00ccff', right: '#cc00ff'}, 'colour defaults');
    eq(defaults.ripple, {duration_ms: 300, start_opacity: 0.8, easing: 'ease-out'}, 'ripple defaults');

    const {mouse} = mergeConfig({mouse: {ring: {radius: 40}, colors: {right: '#ff0000'}}});
    eq(mouse.ring.radius, 40, 'a nested key is used');
    eq(mouse.ring.stroke_width, 3, 'its neighbours keep their defaults');
    eq(mouse.colors, {left: '#ffcc00', middle: '#00ccff', right: '#ff0000'}, 'one colour can change');
    eq(mouse.ripple.duration_ms, 300, 'an absent group keeps its defaults');
}

testButtons();
testConfig();

console.log(failed > 0 ? `${failed} checks failed` : 'all checks passed');
System.exit(failed > 0 ? 1 : 0);
