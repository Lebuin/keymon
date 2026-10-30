// Run with: gjs -m tests/test_config.js

import GLib from 'gi://GLib';
import System from 'system';

import {ConfigWatcher, mergeConfig, readConfig, validateConfig} from '../extension/config.js';

const directory = GLib.dir_make_tmp('keymon-XXXXXX');
const path = `${directory}/config.json`;
const loop = new GLib.MainLoop(null, false);
let failed = false;

function assertEqual(actual, expected, what) {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) {
        failed = true;
        console.log(`FAIL ${what}: got ${a}, expected ${e}`);
    } else {
        console.log(`ok ${what}`);
    }
}

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

const isColor = css => /^(#[0-9a-f]{6}|rgba\(.*\))$/.test(css);
const problem = file => validateConfig(file, isColor);

function testValidation() {
    assertEqual(problem({}), null, 'an empty file is valid');
    assertEqual(problem({unknown: 1, box: {unknown: 2}}), null, 'unknown keys are ignored');
    assertEqual(problem({text: {held_color: null, muted_color: null}}), null, 'optional colours can be null');
    assertEqual(problem({keys: {names: {Return: 'Enter'}}}), null, 'keys.names takes labels');
    assertEqual(problem({text: {weight: 600}}), null, 'text.weight takes a number');

    assertEqual(problem([]), 'the file must hold a JSON object', 'the top level must be an object');
    assertEqual(problem({box: 5}), 'box must be an object', 'a section must be an object');
    assertEqual(problem({mouse: {ring: []}}), 'mouse.ring must be an object', 'a nested section must be an object');
    assertEqual(problem({keys: {names: {Return: 1}}}), 'keys.names.Return must be a string', 'a name must be a string');
    assertEqual(problem({box: {background: 'nope'}}), 'box.background must be a colour, not "nope"', 'a bad colour is named');
    assertEqual(problem({text: {color: null}}), 'text.color must be a colour, not null', 'text.color cannot be null');
    assertEqual(problem({overlay: {origin_h: 'top'}}), 'overlay.origin_h must be left, center, or right, not "top"', 'a bad choice is named');
    assertEqual(problem({keys: {max_runs: 1.5}}), 'keys.max_runs must be a whole number of 1 or more, not 1.5', 'max_runs must be whole');
    assertEqual(problem({mouse: {ripple: {start_opacity: 2}}}), 'mouse.ripple.start_opacity must be a number from 0 to 1, not 2', 'opacity is limited');
    assertEqual(problem({text: {weight: 'heavy'}}), 'text.weight must be normal, bold, or a number from 100 to 900, not "heavy"', 'a bad weight is named');
    assertEqual(problem({toggle_shortcut: '<Super>'}), 'toggle_shortcut must be a shortcut such as <Super><Alt>k, not "<Super>"', 'a shortcut needs a key');
}

function testExample() {
    const example = readConfig(GLib.build_filenamev([GLib.get_current_dir(), 'config.example.json']), isColor);
    assertEqual(example.config, mergeConfig({}), 'config.example.json holds exactly the defaults');
}

function testReading() {
    assertEqual(readConfig(path, isColor), {config: mergeConfig({})}, 'a missing file gives the defaults');

    GLib.file_set_contents(path, '{"box": {"padding_h": 3}}');
    const {config} = readConfig(path, isColor);
    assertEqual([config.box.padding_h, config.box.padding_v], [3, 8], 'missing keys take their default');

    GLib.file_set_contents(path, '{"box": ');
    const broken = readConfig(path, isColor);
    assertEqual([broken.config, typeof broken.error], [undefined, 'string'], 'invalid JSON gives an error');

    GLib.file_set_contents(path, '{"box": {"padding_h": -1}}');
    assertEqual(readConfig(path, isColor).error, 'box.padding_h must be a number of 0 or more, not -1', 'an invalid value gives an error');
    GLib.unlink(path);
}

async function testWatcher() {
    let changes = 0;
    const watcher = new ConfigWatcher(path, () => changes++);
    await wait(50);

    GLib.file_set_contents(path, '{');
    GLib.file_set_contents(path, '{}');
    await wait(1200);
    assertEqual(changes, 1, 'writes close together report one change');

    GLib.unlink(path);
    await wait(1200);
    assertEqual(changes, 2, 'removing the file reports a change');

    // The way many editors save: a new file renamed over the old one.
    GLib.file_set_contents(path, '{}');
    await wait(1200);
    GLib.file_set_contents(`${path}.new`, '{"box": {}}');
    GLib.rename(`${path}.new`, path);
    await wait(1200);
    assertEqual(changes, 4, 'renaming over the file reports a change');

    GLib.file_set_contents(path, '{}');
    watcher.destroy();
    await wait(1200);
    assertEqual(changes, 4, 'destroy() stops reports');
    GLib.unlink(path);
}

async function run() {
    testValidation();
    testExample();
    testReading();
    await testWatcher();
}

run().catch(e => {
    failed = true;
    console.log(`FAIL ${e}\n${e.stack}`);
}).finally(() => {
    GLib.rmdir(directory);
    loop.quit();
});
loop.run();
System.exit(failed ? 1 : 0);
