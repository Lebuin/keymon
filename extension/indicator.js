// The panel icon. A click toggles keymon. The pills reuse the theme's own style for
// GNOME's recording and screen sharing indicators, including their hover states.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const STATES = {
    off: {icon: 'input-keyboard-symbolic', pill: null},
    on: {icon: 'input-keyboard-symbolic', pill: 'screen-sharing-indicator'},
    error: {icon: 'dialog-warning-symbolic', pill: 'screen-recording-indicator'},
};

export class Indicator {
    constructor(uuid, onClick) {
        this._button = new PanelMenu.Button(0.0, 'keymon', true);
        // Without the theme's margin, so that a pill fits the same width as no pill.
        this._icon = new St.Icon({style_class: 'system-status-icon', style: 'margin: 0;'});
        this._button.add_child(this._icon);
        this._button.connect('button-press-event', () => {
            onClick();
            return Clutter.EVENT_STOP;
        });
        this._pill = null;
        this.setState('off');
        Main.panel.addToStatusArea(uuid, this._button);
    }

    setState(state) {
        const {icon, pill} = STATES[state];
        this._icon.icon_name = icon;
        if (this._pill)
            this._button.remove_style_class_name(this._pill);
        if (pill)
            this._button.add_style_class_name(pill);
        this._pill = pill;
    }

    destroy() {
        this._button.destroy();
        this._button = null;
        this._icon = null;
    }
}
