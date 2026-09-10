import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {findChoiceIndex, getChoiceValue} from './choices.js';

function settingAccess(settings, key, choices) {
    if (typeof choices[0].value === 'number') {
        return {
            get: () => settings.get_uint(key),
            set: value => settings.set_uint(key, value),
        };
    }
    return {
        get: () => settings.get_string(key),
        set: value => settings.set_string(key, value),
    };
}

export function addChoiceRow({
    group,
    settings,
    key,
    title,
    choices,
    _,
    addCleanup,
}) {
    if (choices.length === 0)
        throw new Error(`Preference "${key}" has no choices`);

    const row = new Adw.ComboRow({
        title: _(title),
        model: Gtk.StringList.new(choices.map(choice => _(choice.label))),
    });
    const access = settingAccess(settings, key, choices);
    let syncing = false;

    const syncFromSettings = () => {
        let index = findChoiceIndex(choices, access.get());
        if (index < 0) {
            index = 0;
            access.set(choices[0].value);
        }
        syncing = true;
        row.selected = index;
        syncing = false;
    };

    const rowSignalId = row.connect('notify::selected', () => {
        if (!syncing)
            access.set(getChoiceValue(choices, row.selected));
    });
    const settingsSignalId = settings.connect(
        `changed::${key}`, syncFromSettings);
    addCleanup(() => {
        settings.disconnect(settingsSignalId);
        row.disconnect(rowSignalId);
    });

    syncFromSettings();
    group.add(row);
    return row;
}
