// The panel icon. A click toggles keymon, and the colour shows its state.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const COLORS = {
    off: '#9a9a9a',
    on: '#ffcc00',
    error: '#ff5555',
};

export class Indicator {
    constructor(uuid, onClick) {
        this._button = new PanelMenu.Button(0.0, 'keymon', true);
        this._icon = new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            style_class: 'system-status-icon',
        });
        this._button.add_child(this._icon);
        this._button.connect('button-press-event', () => {
            onClick();
            return Clutter.EVENT_STOP;
        });
        this.setState('off');
        Main.panel.addToStatusArea(uuid, this._button);
    }

    setState(state) {
        this._icon.style = `color: ${COLORS[state]};`;
    }

    destroy() {
        this._button.destroy();
        this._button = null;
        this._icon = null;
    }
}
