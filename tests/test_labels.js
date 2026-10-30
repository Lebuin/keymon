// Run with: gjs -m tests/test_labels.js
//
// Covers the path from key code to table entry, and row placement and markup.

import GLib from 'gi://GLib';
import System from 'system';

import {KeyResolver, loadKeymap, parseXkbId} from '../extension/keymap.js';
import {boxHeight, enteringPivot, enteringY, placeRows, restingItems, runItems, textMarkup} from '../extension/layout.js';

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

const LOCKS_OFF = {capsLock: false, numLock: false};
const SHIFT_CODE = 42;
const ALTGR_CODE = 100;
const ONE_CODE = 2;

function repoFile(path) {
    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    return GLib.build_filenamev([here, '..', path]);
}

function testResolver(us, be) {
    const resolver = new KeyResolver();
    eq(resolver.keyDown(ONE_CODE, LOCKS_OFF),
        {keysym: `Key${ONE_CODE}`, text: null, class: 'special'}, 'no table entry gives Key<code>');
    resolver.keyUp(ONE_CODE);

    resolver.setTable(us);
    const textOf = locks => {
        const {text} = resolver.keyDown(ONE_CODE, locks);
        resolver.keyUp(ONE_CODE);
        return text;
    };
    eq(textOf(LOCKS_OFF), '1', 'plain key');

    eq(resolver.keyDown(SHIFT_CODE, LOCKS_OFF).keysym, 'Shift_L', 'Shift resolves');
    eq(textOf(LOCKS_OFF), '!', 'Shift applies to the next press');
    resolver.keyUp(SHIFT_CODE);
    eq(textOf(LOCKS_OFF), '1', 'Shift released');

    resolver.keyDown(ALTGR_CODE, LOCKS_OFF);
    eq(textOf(LOCKS_OFF), '¹', 'AltGr applies');
    resolver.keyUp(ALTGR_CODE);

    resolver.keyDown(SHIFT_CODE, LOCKS_OFF);
    resolver.keyDown(SHIFT_CODE, LOCKS_OFF);
    resolver.keyUp(SHIFT_CODE);
    eq(textOf(LOCKS_OFF), '!', 'Shift on a second keyboard stays held');
    resolver.keyUp(SHIFT_CODE);
    eq(textOf(LOCKS_OFF), '1', 'both Shift keys released');

    resolver.keyUp(99);
    eq(textOf(LOCKS_OFF), '1', 'a stray release is ignored');

    eq(resolver.keyDown(30, {capsLock: true, numLock: false}).text, 'A', 'Caps Lock applies');
    resolver.keyUp(30);
    eq(resolver.keyDown(79, {capsLock: false, numLock: true}).text, '1', 'Num Lock applies');
    resolver.keyUp(79);

    // A layout switch applies to the next press, and a held Shift survives it.
    resolver.keyDown(SHIFT_CODE, LOCKS_OFF);
    eq(textOf(LOCKS_OFF), '!', 'us before the switch');
    resolver.setTable(be);
    eq(textOf(LOCKS_OFF), '1', 'be after the switch');
    resolver.keyUp(SHIFT_CODE);
    eq(textOf(LOCKS_OFF), '&', 'Shift released after the switch');

    resolver.keyDown(SHIFT_CODE, LOCKS_OFF);
    resolver.reset();
    eq(textOf(LOCKS_OFF), '&', 'reset forgets held keys');
}

function testPlacement() {
    const monitor = {x: 100, y: 50, width: 1000, height: 500};
    const overlay = {
        origin_h: 'center', origin_v: 'bottom', anchor_h: 'center', anchor_v: 'bottom',
        offset_x: 0, offset_y: -80, row_spacing: 8,
    };
    const rows = [{width: 100, height: 40}, {width: 200, height: 40}];

    eq(placeRows(monitor, rows, overlay, 'up'),
        [{x: 550, y: 430}, {x: 500, y: 382}], 'bottom center, stacking up');
    eq(placeRows(monitor, rows, {...overlay, origin_h: 'left', origin_v: 'top', anchor_h: 'left', anchor_v: 'top', offset_y: 10}, 'down'),
        [{x: 100, y: 60}, {x: 100, y: 108}], 'top left, stacking down');
    eq(placeRows(monitor, rows, {...overlay, origin_h: 'right', origin_v: 'center', anchor_h: 'right', anchor_v: 'center', offset_y: 0, offset_x: -5}, 'down'),
        [{x: 995, y: 280}, {x: 895, y: 328}], 'right center, negative offset');
    eq(placeRows(monitor, rows, {...overlay, origin_h: 'left', origin_v: 'top', offset_x: 100, offset_y: 100}, 'up'),
        [{x: 150, y: 110}, {x: 100, y: 62}], 'the origin and the anchor are independent');
    eq(placeRows(monitor, rows, {...overlay, origin_v: 'top', anchor_v: 'top', offset_y: 0}, 'up'),
        [{x: 550, y: 50}], 'rows leaving the top are dropped');
    eq(placeRows(monitor, rows, {...overlay, offset_y: 0}, 'down'),
        [{x: 550, y: 510}], 'rows leaving the bottom are dropped');
    eq(placeRows(monitor, rows, {...overlay, offset_y: 0}, 'down', false).length, rows.length,
        'with clip off, rows that leave the monitor are placed too');
    eq(enteringPivot('right', 'up'), {x: 1, y: 0}, 'zooms from the top right when right aligned going up');
    eq(enteringPivot('left', 'down'), {x: 0, y: 1}, 'and from the bottom left when left aligned going down');
    eq(enteringPivot('center', 'up'), {x: 0.5, y: 0}, 'a centred row zooms from the middle of its edge');
    eq(enteringY(500, 40, 8, 'up'), 548, 'a new row starts one row below when older rows go up');
    eq(enteringY(500, 40, 8, 'down'), 452, 'and one row above when they go down');
    eq(placeRows(monitor, [rows[0]], {...overlay, offset_y: 500}, 'up').length, 1,
        'the newest row is kept even off the monitor');
}

function testMarkup() {
    const items = [
        {text: 'a', held: false, muted: false},
        {text: '<', held: true, muted: false},
        {text: '&', held: false, muted: true},
        {text: '⏎', held: true, muted: true},
    ];
    eq(boxHeight(26.25, 5), 37, 'a box is one line and its padding');
    eq(restingItems(items).map(item => item.held), [false, false, false, false], 'nothing is held at rest');
    eq(restingItems(items).map(item => item.text), items.map(item => item.text), 'and the text stays');
    const line = content => `<span line_height="30720">\u2060${content}</span>`;
    eq(textMarkup(items, {held: '#ff0000ff', muted: '#00ff00ff'}, 28, 30),
        line('a<span foreground="#ff0000ff">&lt;</span><span foreground="#00ff00ff">&amp;</span>' +
        '<span foreground="#ff0000ff">⏎</span>'), 'held wins over muted, and all are escaped');
    eq(textMarkup(items, {held: null, muted: null}, 28, 30), line('a&lt;&amp;⏎'), 'no colours');
    eq(textMarkup(items, {held: null, muted: '#00ff00ff'}, 28, 30).includes('<span foreground="#00ff00ff">⏎'), true,
        'a held key uses the muted colour with no held colour');
    eq(textMarkup([{text: '⌫'}], {held: null, muted: null}, 28, 30),
        line('<span size="15053">⌫</span>'), 'the Backspace symbol is scaled down');

    const parts = [{label: 'Ctrl', held: true}, {label: 'c', held: false}];
    eq(runItems({kind: 'modifier', parts}),
        [{text: 'Ctrl', held: true, muted: true}, {text: '+', held: false, muted: true}, {text: 'c', held: false, muted: true}],
        'modifier parts are joined by a plus');
    eq(runItems({kind: 'text', items}), items, 'text items pass through');
}

const loop = new GLib.MainLoop(null, false);
const tool = repoFile('extension/keymon-keymap');

eq(parseXkbId('us+altgr-intl'), {layout: 'us', variant: 'altgr-intl'}, 'layout and variant');
eq(parseXkbId('be'), {layout: 'be', variant: ''}, 'layout only');
testPlacement();
testMarkup();

Promise.all([loadKeymap(tool, 'us+altgr-intl', []), loadKeymap(tool, 'be', [])]).then(async ([us, be]) => {
    testResolver(us, be);
    const error = await loadKeymap(tool, 'not-a-layout', []).catch(e => e.message);
    eq(error.includes('not-a-layout'), true, 'a failing layout rejects');
}).catch(e => {
    failed++;
    console.log(`FAIL ${e.message}\n${e.stack}`);
}).finally(() => loop.quit());

loop.run();
System.exit(failed > 0 ? 1 : 0);
