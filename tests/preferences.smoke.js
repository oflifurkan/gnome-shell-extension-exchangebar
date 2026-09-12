import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {fillPreferencesWindow} from '../prefs/preferences.js';

Adw.init();

const schemaDirectory = GLib.build_filenamev([
    GLib.get_current_dir(), 'schemas',
]);
const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    schemaDirectory, Gio.SettingsSchemaSource.get_default(), false);
const schema = schemaSource.lookup(
    'org.gnome.shell.extensions.exchangebar', false);
if (!schema)
    throw new Error('ExchangeBar settings schema was not found');

const settings = new Gio.Settings({settings_schema: schema});
settings.set_string('panel-position', 'center');

const window = new Adw.PreferencesWindow();
fillPreferencesWindow(
    window,
    settings,
    {'version-name': '0.1.0'},
    message => message);

if (settings.get_string('panel-position') !== 'center')
    throw new Error('Preferences did not preserve the panel position');

window.emit('close-request');
window.destroy();
print('preferences smoke test passed');
System.exit(0);
