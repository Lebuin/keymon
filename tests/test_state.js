// Run with: gjs -m tests/test_state.js
//
// Each test names the rule it checks from SPEC.md section 7. A row is written as
// its boxes joined by spaces, or as the text of its one box. Rows are newest
// first, and held keys are wrapped in asterisks by shownHeld().

import System from 'system';

import {DisplayState} from '../extension/state.js';

const CONFIG = {
    run_visible_ms: 3000,
    run_gap_ms: 2000,
    shift_delay_ms: 200,
    run_max_chars: 30,
    max_runs: 5,
    space_symbol: '␣',
    names: {},
};

// The evdev code and keymap table entry of each key used here.
function key(code, keysym, text = null, cls = 'special') {
    return {code, keysym, text, class: cls};
}
function printable(code, text, keysym = text) {
    return key(code, keysym, text, 'printable');
}
function modifier(code, keysym) {
    return key(code, keysym, null, 'modifier');
}

const K = {
    a: printable(30, 'a'), s: printable(31, 's'), c: printable(46, 'c'), v: printable(47, 'v'),
    m: printable(50, 'm'), t: printable(20, 't'), T: printable(20, 'T'),
    one: printable(2, '1'), bang: printable(2, '!', 'exclam'),
    space: printable(57, ' ', 'space'),
    ctrl: modifier(29, 'Control_L'), ctrlR: modifier(97, 'Control_R'),
    alt: modifier(56, 'Alt_L'), meta: modifier(56, 'Meta_L'), superL: modifier(125, 'Super_L'),
    shift: modifier(42, 'Shift_L'), shiftR: modifier(54, 'Shift_R'),
    altgr: modifier(100, 'ISO_Level3_Shift'),
    enter: key(28, 'Return'), kpEnter: key(96, 'KP_Enter'),
    backspace: key(14, 'BackSpace'), tab: key(15, 'Tab'), leftTab: key(15, 'ISO_Left_Tab'),
    left: key(105, 'Left'), esc: key(1, 'Escape'), f5: key(63, 'F5'), del: key(111, 'Delete'),
    caps: key(58, 'Caps_Lock'), unknown: key(240, 'XF86Foo'),
};

let failed = 0;
let passed = 0;

function eq(actual, expected, what) {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a === e) {
        passed++;
    } else {
        failed++;
        console.log(`FAIL ${what}: got ${a}, expected ${e}`);
    }
}

// A display with a fake clock, and shorthand for driving it.
function setup(config = {}) {
    const clock = {time: 1000};
    const state = new DisplayState({...CONFIG, ...config}, () => clock.time);
    return {
        state,
        wait(ms) {
            clock.time += ms;
            state.tick();
        },
        down: k => state.keyDown(k.code, k),
        up: k => state.keyUp(k.code),
        tap(...keys) {
            for (const k of keys) {
                state.keyDown(k.code, k);
                state.keyUp(k.code);
            }
        },
        click: () => state.mouseDown(),
        shown: () => state.runs().map(run => render(run)),
        shownHeld: () => state.runs().map(run => render(run, true)),
        now: () => clock.time,
    };
}

function render(run, marks = false) {
    const mark = part => (marks && part.held ? `*${part.label ?? part.text}*` : part.label ?? part.text);
    if (run.kind === 'modifier')
        return run.boxes.map(mark).join(' ');
    return (run.truncated ? '…' : '') + run.items.map(mark).join('');
}

function test(name, body) {
    const before = failed;
    try {
        body();
    } catch (e) {
        failed++;
        console.log(`FAIL ${e}\n${e.stack}`);
    }
    console.log(`${failed === before ? 'ok' : 'NOT OK'} ${name}`);
}

// Visibility

test('a quick tap stays for the full visible time', () => {
    const d = setup();
    d.tap(K.a);
    d.wait(2999);
    eq(d.shown(), ['a'], 'just before the end');
    d.wait(1);
    eq(d.shown(), [], 'at the end');
});

test('gaining a character restarts the timer', () => {
    const d = setup();
    d.tap(K.a);
    d.wait(1500);
    d.tap(K.s);
    d.wait(2999);
    eq(d.shown(), ['as'], 'old character does not expire the run');
    d.wait(1);
    eq(d.shown(), [], 'expires from the last change');
});

test('losing a character restarts the timer', () => {
    const d = setup();
    d.tap(K.a, K.s);
    d.wait(1500);
    d.tap(K.backspace);
    d.wait(2999);
    eq(d.shown(), ['a'], 'still there');
    d.wait(1);
    eq(d.shown(), [], 'expires');
});

test('the newest run ignores its timer while a key is held', () => {
    const d = setup();
    d.down(K.ctrl);
    d.wait(10000);
    d.click();
    d.wait(10000);
    eq(d.shown(), ['Ctrl'], 'held through a long Ctrl+click');
    d.up(K.ctrl);
    d.wait(2999);
    eq(d.shown(), ['Ctrl'], 'timer starts at release');
    d.wait(1);
    eq(d.shown(), [], 'expires after release');
});

test('a held key in a text run keeps it, until the last one is released', () => {
    const d = setup();
    d.down(K.a);
    d.down(K.s);
    d.wait(5000);
    d.up(K.a);
    d.wait(5000);
    eq(d.shown(), ['as'], 'one key still held');
    d.up(K.s);
    d.wait(3000);
    eq(d.shown(), [], 'expires after the last release');
});

test('a run replaced as newest starts its timer even if still held', () => {
    const d = setup();
    d.down(K.a);
    d.wait(5000);
    d.down(K.ctrl);
    eq(d.shown(), ['Ctrl', 'a'], 'both rows');
    d.wait(2999);
    eq(d.shown(), ['Ctrl', 'a'], 'still there');
    d.wait(1);
    eq(d.shown(), ['Ctrl'], 'expired with its key held');
});

test('a replaced run that was already counting keeps counting', () => {
    const d = setup();
    d.tap(K.a);
    d.wait(2000);
    d.down(K.ctrl);
    d.wait(999);
    eq(d.shown(), ['Ctrl', 'a'], 'still there');
    d.wait(1);
    eq(d.shown(), ['Ctrl'], 'expires on its original schedule');
});

test('an old run does not start waiting again when the newer one goes', () => {
    const d = setup();
    d.down(K.a);
    d.down(K.ctrl);
    d.up(K.ctrl);
    d.wait(3000);
    eq(d.shown(), [], 'both expire, although a is still held');
});

test('nextDeadline gives the next time something changes', () => {
    const d = setup();
    eq(d.state.nextDeadline(), null, 'nothing shown');
    d.down(K.a);
    eq(d.state.nextDeadline(), null, 'waiting on a held key');
    d.up(K.a);
    eq(d.state.nextDeadline(), d.now() + 3000, 'the run timer');
    d.down(K.shift);
    eq(d.state.nextDeadline(), d.now() + 200, 'the shift delay comes first');
});

// Held key colour

test('held keys are marked on every visible row', () => {
    const d = setup();
    d.down(K.ctrl);
    d.tap(K.c);
    d.tap(K.v);
    eq(d.shownHeld(), ['*Ctrl* v', '*Ctrl* c'], 'Ctrl on both rows');
    d.up(K.ctrl);
    eq(d.shownHeld(), ['Ctrl v', 'Ctrl c'], 'reverts at release');
});

test('each box of a modifier run is marked separately', () => {
    const d = setup();
    d.down(K.ctrl);
    d.down(K.alt);
    d.up(K.alt);
    eq(d.shownHeld(), ['*Ctrl* Alt'], 'only Ctrl');
});

test('only the held characters of a text run are marked', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.s);
    eq(d.shownHeld(), ['a*s*'], 'only s');
    d.up(K.s);
    eq(d.shownHeld(), ['as'], 'none');
});

test('pressing a key again does not mark its earlier character', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.a);
    eq(d.shownHeld(), ['a*a*'], 'only the new one');
});

test('left and right variants mark one box until neither is held', () => {
    const d = setup();
    d.down(K.ctrl);
    d.down(K.ctrlR);
    eq(d.shownHeld(), ['*Ctrl*'], 'one box');
    d.up(K.ctrl);
    eq(d.shownHeld(), ['*Ctrl*'], 'right still held');
    d.up(K.ctrlR);
    eq(d.shownHeld(), ['Ctrl'], 'neither held');
});

// Stack

test('new runs go first, and the oldest goes past max_runs', () => {
    const d = setup({max_runs: 2});
    d.tap(K.ctrl, K.alt, K.superL);
    eq(d.shown(), ['Super', 'Alt'], 'limited to two');
});

test('a run disappearing closes the gap', () => {
    const d = setup();
    d.tap(K.ctrl);
    d.wait(1000);
    d.tap(K.alt);
    d.wait(1000);
    d.tap(K.superL);
    d.wait(1000);
    eq(d.shown(), ['Super', 'Alt'], 'the oldest is gone');
});

test('dropOldest never removes the newest run', () => {
    const d = setup();
    d.tap(K.ctrl, K.alt);
    eq(d.state.dropOldest(), true, 'removes one');
    eq(d.shown(), ['Alt'], 'the newest stays');
    eq(d.state.dropOldest(), false, 'refuses');
    eq(d.shown(), ['Alt'], 'still there');
});

// Text runs

test('typing merges into one run', () => {
    const d = setup();
    for (const code of [K.a, K.s, K.a])
        d.tap(code);
    eq(d.shown(), ['asa'], 'one box');
});

test('space uses the space symbol', () => {
    const d = setup();
    d.tap(K.a, K.space);
    eq(d.shown(), ['a␣'], 'trailing space is visible');
});

test('keys held together merge', () => {
    const d = setup();
    d.down(K.a);
    d.down(K.s);
    eq(d.shown(), ['as'], 'one box');
});

test('auto-repeat never reaches the state, and a second keyboard adds nothing', () => {
    const d = setup();
    d.down(K.a);
    d.down(K.a);
    eq(d.shown(), ['a'], 'one character');
    d.up(K.a);
    eq(d.shownHeld(), ['*a*'], 'still held on the other keyboard');
    d.up(K.a);
    eq(d.shownHeld(), ['a'], 'released on both');
});

test('labels stay locked at press, and release matches by code', () => {
    const d = setup();
    d.down(K.one);
    d.down(K.shift);
    eq(d.shown(), ['1'], 'Shift does not change the label');
    d.wait(200);
    d.up(K.one);
    eq(d.shownHeld(), ['*Shift*', '1'], 'released by code');
});

test('text is cut to the last run_max_chars, with a leading ellipsis flag', () => {
    const d = setup({run_max_chars: 3});
    d.tap(K.a, K.s, K.c);
    eq(d.shown(), ['asc'], 'exactly at the limit');
    d.tap(K.v);
    eq(d.shown(), ['…scv'], 'cut');
});

test('a token counts by its length and is never split', () => {
    const d = setup({run_max_chars: 7});
    d.tap(K.a, K.s, K.esc);
    eq(d.shown(), ['as‹Esc›'], 'fits exactly');
    d.tap(K.esc);
    eq(d.shown(), ['…‹Esc›'], 'an earlier token drops whole');
});

test('erasing brings cut text back', () => {
    const d = setup({run_max_chars: 2});
    d.tap(K.a, K.s, K.c);
    eq(d.shown(), ['…sc'], 'cut');
    d.tap(K.backspace);
    eq(d.shown(), ['as'], 'whole again');
});

test('a new run starts after the gap since a press or release', () => {
    const d = setup();
    d.tap(K.a);
    d.wait(1999);
    d.tap(K.s);
    eq(d.shown(), ['as'], 'inside the gap');
    d.wait(2000);
    d.tap(K.c);
    eq(d.shown(), ['c', 'as'], 'past the gap');
});

test('a release counts as activity for the gap', () => {
    const d = setup();
    d.down(K.a);
    d.wait(1500);
    d.up(K.a);
    d.wait(1500);
    d.tap(K.s);
    eq(d.shown(), ['as'], 'measured from the release');
});

test('mouse activity does not affect text runs', () => {
    const d = setup();
    d.tap(K.a);
    d.click();
    d.tap(K.s);
    eq(d.shown(), ['as'], 'still one run');
});

// Special keys in a text run

test('tokens show their glyph or quoted label', () => {
    const d = setup({run_max_chars: 40});
    d.tap(K.tab, K.left, K.esc, K.f5, K.del, K.caps, K.unknown);
    eq(d.shown(), ['⇥←‹Esc›‹F5›‹Del›‹Caps›‹XF86Foo›'], 'tokens');
});

test('keys.names changes the label inside the quotes, not the glyphs', () => {
    const d = setup({names: {Escape: 'Escape!', Tab: 'nope', F5: 'Reload'}});
    d.tap(K.esc, K.f5, K.tab);
    eq(d.shown(), ['‹Escape!›‹Reload›⇥'], 'tokens');
});

test('Enter ends the run', () => {
    const d = setup();
    d.tap(K.a, K.enter, K.s);
    eq(d.shown(), ['s', 'a⏎'], 'two rows');
});

test('keypad Enter behaves as Enter, and Enter alone shows just its token', () => {
    const d = setup();
    d.tap(K.kpEnter);
    eq(d.shown(), ['⏎'], 'token');
    d.tap(K.a);
    eq(d.shown(), ['a', '⏎'], 'the run ended');
});

test('Backspace erases a character, space included', () => {
    const d = setup();
    d.tap(K.a, K.space, K.backspace);
    eq(d.shown(), ['a'], 'erased');
});

test('Backspace after a token or with no run shows a token', () => {
    const d = setup();
    d.tap(K.backspace);
    eq(d.shown(), ['⌫'], 'no run');
    d.wait(3000);
    d.tap(K.a, K.left, K.backspace);
    eq(d.shown(), ['a←⌫'], 'after a token');
    d.tap(K.backspace);
    eq(d.shown(), ['a←⌫⌫'], 'after its own token');
});

test('erasing the last character removes the run', () => {
    const d = setup();
    d.tap(K.m);
    d.wait(2500);
    d.tap(K.a);
    d.tap(K.backspace);
    eq(d.shown(), ['m'], 'the new run is gone');
    d.tap(K.s);
    eq(d.shown(), ['s', 'm'], 'the next key starts a new run');
});

test('Backspace after the gap starts a new run, and does not erase', () => {
    const d = setup();
    d.tap(K.a);
    d.wait(2000);
    d.tap(K.backspace);
    eq(d.shown(), ['⌫', 'a'], 'old run is untouched');
});

test('Backspace after Enter shows a new run', () => {
    const d = setup();
    d.tap(K.a, K.enter, K.backspace);
    eq(d.shown(), ['⌫', 'a⏎'], 'the ended run is untouched');
});

// Modifier runs

test('a hard modifier shows at once and ends the text run', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.ctrl);
    eq(d.shown(), ['Ctrl', 'a'], 'at once');
    d.up(K.ctrl);
    d.tap(K.s);
    eq(d.shown(), ['s', 'Ctrl', 'a'], 'text does not join the earlier run');
});

test('modifiers keep a fixed order, whatever the press order', () => {
    const d = setup();
    d.down(K.superL);
    d.down(K.shift);
    d.down(K.alt);
    d.down(K.ctrl);
    d.down(K.altgr);
    eq(d.shown(), ['Ctrl Alt AltGr Shift Super'], 'one row');
});

test('Shift+Alt producing Meta is still Alt', () => {
    const d = setup();
    d.down(K.ctrl);
    d.down(K.meta);
    eq(d.shown(), ['Ctrl Alt'], 'one Alt box');
});

test('tapping two modifiers gives two rows', () => {
    const d = setup();
    d.tap(K.ctrl, K.alt);
    eq(d.shown(), ['Alt', 'Ctrl'], 'two rows');
});

test('a modifier joins while one in the run is held', () => {
    const d = setup();
    d.down(K.ctrl);
    d.down(K.alt);
    d.up(K.ctrl);
    d.down(K.superL);
    eq(d.shown(), ['Ctrl Alt Super'], 'one row');
});

test('a released modifier pressed again starts a new row', () => {
    const d = setup();
    d.tap(K.ctrl);
    d.down(K.ctrl);
    eq(d.shownHeld(), ['*Ctrl*', '*Ctrl*'], 'two rows');
});

test('the other variant of a held modifier changes nothing', () => {
    const d = setup();
    d.down(K.ctrl);
    d.tap(K.c);
    d.down(K.ctrlR);
    eq(d.shown(), ['Ctrl c'], 'no new row');
});

test('Ctrl+C then V gives two rows, and a following letter is text', () => {
    const d = setup();
    d.down(K.ctrl);
    d.tap(K.c, K.v);
    d.up(K.ctrl);
    eq(d.shown(), ['Ctrl v', 'Ctrl c'], 'one key per row');
    d.tap(K.m);
    eq(d.shown(), ['m', 'Ctrl v', 'Ctrl c'], 'text run');
});

test('an earlier text run keeps its row through a chord', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.ctrl);
    d.tap(K.c);
    d.up(K.ctrl);
    d.tap(K.m);
    eq(d.shown(), ['m', 'Ctrl c', 'a'], 'three rows');
});

test('a modifier after a completed run starts a row of all held modifiers', () => {
    const d = setup();
    d.down(K.ctrl);
    d.tap(K.c);
    d.down(K.shift);
    eq(d.shown(), ['Ctrl Shift', 'Ctrl c'], 'new row');
});

test('a released modifier is not shown with the key', () => {
    const d = setup();
    d.down(K.ctrl);
    d.down(K.alt);
    d.up(K.alt);
    d.tap(K.c);
    eq(d.shown(), ['Ctrl c', 'Ctrl Alt'], 'new row');
});

test('a chorded key is labelled with its text, and Space with its name', () => {
    const d = setup();
    d.down(K.ctrl);
    d.tap(K.space, K.enter, K.left);
    eq(d.shown(), ['Ctrl ←', 'Ctrl Enter', 'Ctrl Space'], 'labels');
});

test('keys.names applies in modifier runs, to both variants', () => {
    const d = setup({names: {Control_R: 'Strg', Return: 'Ret', c: 'C!'}});
    d.down(K.ctrl);
    d.tap(K.c, K.enter);
    eq(d.shown(), ['Strg Ret', 'Strg C!'], 'overrides');
});

test('a click does not change a modifier run, and is not its key', () => {
    const d = setup();
    d.down(K.ctrl);
    d.click();
    eq(d.shown(), ['Ctrl'], 'unchanged');
    d.tap(K.c);
    eq(d.shown(), ['Ctrl c'], 'the key still completes it');
});

// Shift and AltGr

for (const [name, soft] of [['Shift', K.shift], ['AltGr', K.altgr]]) {
    test(`${name} alone shows nothing until the delay`, () => {
        const d = setup();
        d.down(soft);
        d.wait(199);
        eq(d.shown(), [], 'pending');
        d.wait(1);
        eq(d.shown(), [name], 'standalone');
    });

    test(`${name} tapped shows at the end of the delay and stays its full time`, () => {
        const d = setup();
        d.tap(soft);
        eq(d.shown(), [], 'pending');
        d.wait(200);
        eq(d.shown(), [name], 'standalone');
        d.wait(2999);
        eq(d.shown(), [name], 'still there');
        d.wait(1);
        eq(d.shown(), [], 'gone');
    });

    test(`${name} with a special key shows at once`, () => {
        const d = setup();
        d.down(soft);
        d.tap(K.tab);
        eq(d.shown(), [`${name} Tab`], 'modifier run');
    });

    test(`${name} with a printable key within the delay is absorbed`, () => {
        const d = setup();
        d.tap(K.a);
        d.down(soft);
        d.tap(K.bang);
        d.wait(500);
        eq(d.shown(), ['a!'], 'joins the run, with no row');
    });
}

test('Shift+Tab with the ISO_Left_Tab keysym is labelled Tab', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.leftTab);
    eq(d.shown(), ['Shift Tab'], 'label');
});

test('Shift+Tab ends the text run', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.shift);
    d.tap(K.leftTab);
    d.up(K.shift);
    d.tap(K.s);
    eq(d.shown(), ['s', 'Shift Tab', 'a'], 'three rows');
});

test('a hard modifier within the delay shows with the soft one', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.shift);
    d.wait(50);
    d.down(K.ctrl);
    eq(d.shown(), ['Ctrl Shift', 'a'], 'at once');
});

test('a mouse press within the delay shows the modifier at the click', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.shift);
    d.wait(50);
    d.click();
    eq(d.shown(), ['Shift', 'a'], 'at once');
    d.tap(K.s);
    d.wait(1000);
    eq(d.shown(), ['s', 'a'], 'the row gives way, and no second row comes');
});

test('the standalone row ends the current text run', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.shift);
    d.wait(200);
    d.up(K.shift);
    d.tap(K.s);
    eq(d.shown(), ['s', 'Shift', 'a'], 'three rows');
});

test('releasing within the delay changes nothing', () => {
    const d = setup();
    d.tap(K.a);
    d.tap(K.shift);
    d.tap(K.one);
    d.wait(500);
    eq(d.shown(), ['a1'], 'unshifted, with no Shift row');
});

test('a special key within the delay shows the modifier, even after its release', () => {
    const d = setup();
    d.tap(K.shift);
    d.tap(K.tab);
    eq(d.shown(), ['Shift Tab'], 'modifier run');
});

test('a hard modifier within the delay shows the soft one, even after its release', () => {
    const d = setup();
    d.tap(K.shift);
    d.down(K.ctrl);
    eq(d.shown(), ['Ctrl Shift'], 'modifier run');
    eq(d.shownHeld(), ['*Ctrl* Shift'], 'only Ctrl is held');
});

test('after absorption, printable keys keep joining with no row', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.bang);
    d.wait(1000);
    d.tap(K.T);
    d.wait(1000);
    eq(d.shown(), ['!T'], 'one run');
});

test('after absorption, the gap still starts a new run, with no row', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.T);
    d.wait(2000);
    d.tap(K.T);
    eq(d.shown(), ['T', 'T'], 'two runs');
});

test('after absorption, a special key starts a modifier run', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.bang);
    d.wait(1000);
    d.tap(K.tab);
    eq(d.shown(), ['Shift Tab', '!'], 'modifier run');
});

test('after absorption, a mouse press starts a modifier run', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.bang);
    d.wait(1000);
    d.click();
    eq(d.shown(), ['Shift', '!'], 'modifier run');
    d.click();
    eq(d.shown(), ['Shift', '!'], 'a second click adds nothing');
});

test('after absorption, a hard modifier joins with the held Shift', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.bang);
    d.wait(1000);
    d.down(K.ctrl);
    eq(d.shown(), ['Ctrl Shift', '!'], 'all held modifiers');
    d.tap(K.T);
    eq(d.shown(), ['Ctrl Shift T', '!'], 'the key completes it');
});

test('a released absorbed modifier leaves no trace for a click', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.bang);
    d.up(K.shift);
    d.click();
    eq(d.shown(), ['!'], 'no row');
});

test('a printable key replaces a held standalone row in place', () => {
    const d = setup();
    d.tap(K.a);
    d.down(K.shift);
    d.wait(200);
    eq(d.shown(), ['Shift', 'a'], 'standalone');
    d.tap(K.bang);
    eq(d.shown(), ['!', 'a'], 'replaced, not merged');
    d.tap(K.T);
    eq(d.shown(), ['!T', 'a'], 'further keys join the new run');
});

test('a special key is added to a held standalone row', () => {
    const d = setup();
    d.down(K.shift);
    d.wait(200);
    d.tap(K.tab);
    eq(d.shown(), ['Shift Tab'], 'same row');
    d.tap(K.tab);
    eq(d.shown(), ['Shift Tab', 'Shift Tab'], 'a run holds one key');
});

test('after release, a standalone row stays and printable keys start a new row', () => {
    const d = setup();
    d.down(K.shift);
    d.wait(200);
    d.up(K.shift);
    d.tap(K.one);
    eq(d.shown(), ['1', 'Shift'], 'new row');
});

test('a standalone row is not replaced by a later Shift+key', () => {
    const d = setup();
    d.tap(K.shift);
    d.wait(200);
    d.down(K.shift);
    d.tap(K.bang);
    eq(d.shown(), ['!', 'Shift'], 'new row');
});

test('a row with a hard modifier is not replaced by a printable key', () => {
    const d = setup();
    d.down(K.ctrl);
    d.down(K.shift);
    d.up(K.ctrl);
    d.tap(K.bang);
    eq(d.shown(), ['!', 'Ctrl Shift'], 'new row');
});

test('Shift while a hard modifier is held joins at once', () => {
    const d = setup();
    d.down(K.ctrl);
    d.down(K.shift);
    eq(d.shown(), ['Ctrl Shift'], 'no delay');
    d.tap(K.T);
    eq(d.shown(), ['Ctrl Shift T'], 'the chord');
});

test('the second Shift of a pair changes nothing', () => {
    const d = setup();
    d.down(K.shift);
    d.tap(K.bang);
    d.down(K.shiftR);
    d.wait(500);
    eq(d.shown(), ['!'], 'still absorbed');
    d.up(K.shift);
    d.tap(K.tab);
    eq(d.shown(), ['Shift Tab', '!'], 'the right one still counts as held');
});

test('Shift and AltGr pending together resolve together', () => {
    const d = setup();
    d.down(K.shift);
    d.wait(100);
    d.down(K.altgr);
    d.wait(100);
    eq(d.shown(), ['AltGr Shift'], 'one row');
});

test('an event arriving after a missed deadline sees it as passed', () => {
    let time = 0;
    const state = new DisplayState(CONFIG, () => time);
    state.keyDown(K.ctrl.code, K.ctrl);
    state.keyUp(K.ctrl.code);
    state.keyDown(K.shift.code, K.shift);
    time = 300;
    state.keyDown(K.bang.code, K.bang);
    eq(state.runs().map(run => render(run)), ['!', 'Ctrl'],
        'the Shift row appeared, then gave way to the character');
    time = 3000;
    state.tick();
    eq(state.runs().map(run => render(run)), ['!'], 'a missed run timer is caught up too');
});

// Stale state

test('a release with no matching press is ignored', () => {
    const d = setup();
    d.up(K.ctrl);
    eq(d.shown(), [], 'nothing shown');
    d.tap(K.a);
    d.up(K.ctrl);
    eq(d.shown(), ['a'], 'nothing changes');
});

test('reset clears runs, held keys and pending modifiers', () => {
    const d = setup();
    d.down(K.ctrl);
    d.tap(K.c);
    d.state.reset();
    eq(d.shown(), [], 'no runs');
    eq(d.state.nextDeadline(), null, 'no deadlines');
    d.up(K.ctrl);
    d.tap(K.m);
    eq(d.shown(), ['m'], 'Ctrl is no longer held');

    d.state.reset();
    d.down(K.shift);
    d.state.reset();
    d.wait(1000);
    eq(d.shown(), [], 'the pending Shift is gone');
});

console.log(`${passed} checks passed, ${failed} failed`);
System.exit(failed > 0 ? 1 : 0);
