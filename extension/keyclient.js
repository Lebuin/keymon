// Client for the helper's socket. It has no Shell imports, so that it can be
// tested under plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SOCKET_PATH = '/run/keymon/keys.sock';

// The wait before each reconnect: 1, 2, 4, up to 30 s.
export class Backoff {
    constructor() {
        this.reset();
    }

    reset() {
        this._delay = 1000;
    }

    next() {
        const delay = this._delay;
        this._delay = Math.min(delay * 2, 30000);
        return delay;
    }
}

export class KeyClient {
    // onKey(code, down) runs per key event, onConnected() once connected, and
    // onDisconnected(message, wasConnected) when the connection fails or ends.
    // wasConnected is false if it never got as far as connecting. None of them run
    // after close().
    constructor(path, {onKey, onConnected, onDisconnected}) {
        this._path = path;
        this._onKey = onKey;
        this._onConnected = onConnected;
        this._onDisconnected = onDisconnected;
        this._cancellable = null;
        this._connection = null;
    }

    connect() {
        this.close();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        new Gio.SocketClient().connect_async(
            Gio.UnixSocketAddress.new(this._path), cancellable, (client, result) => {
                try {
                    const connection = client.connect_finish(result);
                    if (cancellable.is_cancelled()) {
                        connection.close(null);
                        return;
                    }
                    this._connection = connection;
                } catch (e) {
                    this._lost(cancellable, e.message, false);
                    return;
                }
                this._onConnected();
                const stream = new Gio.DataInputStream({
                    base_stream: this._connection.get_input_stream(),
                });
                this._readLine(stream, cancellable);
            });
    }

    close() {
        this._cancellable?.cancel();
        this._cancellable = null;
        const connection = this._connection;
        this._connection = null;
        try {
            connection?.close(null);
        } catch (e) {
            console.log(`keymon: closing the helper connection: ${e.message}`);
        }
    }

    _readLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            let event;
            try {
                const [line] = source.read_line_finish_utf8(result);
                if (line === null) {
                    this._lost(cancellable, 'the helper closed the connection', true);
                    return;
                }
                event = JSON.parse(line);
            } catch (e) {
                this._lost(cancellable, e.message, true);
                return;
            }
            if (cancellable.is_cancelled())
                return;
            this._onKey(event.code, event.down);
            // The callback may have closed the client.
            if (!cancellable.is_cancelled())
                this._readLine(stream, cancellable);
        });
    }

    _lost(cancellable, message, wasConnected) {
        if (cancellable.is_cancelled())
            return;
        this.close();
        this._onDisconnected(message, wasConnected);
    }
}
