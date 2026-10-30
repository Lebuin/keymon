// Run with: gjs -m tests/test_keyclient.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {Backoff, KeyClient} from '../extension/keyclient.js';

const directory = GLib.dir_make_tmp('keymon-XXXXXX');
const path = `${directory}/keys.sock`;
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

function collect() {
    const seen = [];
    const client = new KeyClient(path, {
        onConnected: () => seen.push('connected'),
        onKey: (code, down) => seen.push([code, down]),
        onDisconnected: (_message, wasConnected) => seen.push(wasConnected ? 'disconnected' : 'not connected'),
    });
    return {seen, client};
}

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function write(connection, text) {
    connection.get_output_stream().write_all(new TextEncoder().encode(text), null);
}

function testBackoff() {
    const backoff = new Backoff();
    const delays = Array.from({length: 7}, () => backoff.next());
    assertEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000], 'the wait doubles up to 30 s');
    backoff.reset();
    assertEqual(backoff.next(), 1000, 'reset() starts over');
}

async function run() {
    testBackoff();

    const missing = collect();
    missing.client.connect();
    await wait(50);
    assertEqual(missing.seen, ['not connected'], 'a missing socket reports a failure to connect');

    const service = new Gio.SocketService();
    service.add_address(Gio.UnixSocketAddress.new(path),
        Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    const server = [];
    service.connect('incoming', (_, connection) => {
        server.push(connection);
        return true;
    });
    service.start();

    const reading = collect();
    reading.client.connect();
    await wait(50);
    write(server[0], '{"code": 30, "down": true}\n{"code": 30, "down": false}\n{"code": 31,');
    await wait(50);
    assertEqual(reading.seen, ['connected', [30, true], [30, false]], 'complete lines become keys');
    write(server[0], ' "down": true}\n');
    await wait(50);
    assertEqual(reading.seen.at(-1), [31, true], 'a line split across writes is joined');
    server[0].close(null);
    await wait(50);
    assertEqual(reading.seen.at(-1), 'disconnected', 'the helper leaving reports a disconnect');

    const closing = collect();
    closing.client.connect();
    await wait(50);
    closing.client.close();
    await wait(50);
    const count = server[1].get_input_stream().read_bytes(1, null).get_size();
    assertEqual(count, 0, 'close() ends the connection for the helper');
    assertEqual(closing.seen, ['connected'], 'close() runs no callbacks');

    const reused = collect();
    reused.client.connect();
    reused.client.close();
    await wait(50);
    assertEqual(reused.seen, [], 'close() during connect runs no callbacks');

    const bad = collect();
    bad.client.connect();
    await wait(50);
    write(server.at(-1), 'not json\n');
    await wait(50);
    assertEqual(bad.seen, ['connected', 'disconnected'], 'a bad line reports a disconnect');
    service.stop();
}

run().catch(e => {
    failed = true;
    console.log(`FAIL ${e}\n${e.stack}`);
}).finally(() => {
    GLib.unlink(path);
    GLib.rmdir(directory);
    loop.quit();
});
loop.run();
System.exit(failed ? 1 : 0);
