import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {fillPreferencesWindow} from './prefs/preferences.js';

export default class ExchangeBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        fillPreferencesWindow(
            window,
            this.getSettings(),
            this.metadata,
            this.gettext.bind(this));
    }
}
