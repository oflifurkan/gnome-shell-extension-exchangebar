import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {createProviderSettingsPage} from './providerSettings.js';

function addSwitch(group, settings, key, title) {
    const row = new Adw.SwitchRow({title});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addPrecision(group, settings, key, title, upper) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper,
            step_increment: 1,
            page_increment: 1,
        }),
        digits: 0,
        numeric: true,
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

export function fillPreferencesWindow(window, settings, metadata, _) {
    const cleanups = [];
    let cleanedUp = false;
    const addCleanup = callback => cleanups.push(callback);
    window.connect('close-request', () => {
        if (!cleanedUp) {
            cleanedUp = true;
            for (const cleanup of cleanups)
                cleanup();
            cleanups.length = 0;
        }
        return false;
    });

    const appearancePage = new Adw.PreferencesPage({
        title: _('Appearance'),
        icon_name: 'preferences-desktop-appearance-symbolic',
    });
    const panelGroup = new Adw.PreferencesGroup({title: _('Panel items')});
    addSwitch(panelGroup, settings, 'show-usd', _('USD / TRY'));
    addSwitch(panelGroup, settings, 'show-eur', _('EUR / TRY'));
    addSwitch(panelGroup, settings, 'show-gold', _('Gram Gold / TRY'));
    appearancePage.add(panelGroup);

    const formatGroup = new Adw.PreferencesGroup({title: _('Number Format')});
    addPrecision(formatGroup, settings, 'currency-precision',
        _('Currency decimal places'), 6);
    addPrecision(formatGroup, settings, 'gold-precision',
        _('Gold decimal places'), 4);
    appearancePage.add(formatGroup);
    window.add(appearancePage);
    window.add(createProviderSettingsPage(settings, _, addCleanup));

    const aboutPage = new Adw.PreferencesPage({
        title: _('About'),
        icon_name: 'help-about-symbolic',
    });
    const aboutGroup = new Adw.PreferencesGroup();
    aboutGroup.add(new Adw.ActionRow({
        title: _('ExchangeBar'),
        subtitle: _('Version %s')
            .replace('%s', metadata['version-name'] ?? '0.1.0'),
    }));
    aboutPage.add(aboutGroup);
    window.add(aboutPage);
}
