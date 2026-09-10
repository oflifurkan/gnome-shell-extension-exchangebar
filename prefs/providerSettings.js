import Adw from 'gi://Adw';

import {
    getProviderPreferences,
    listProviderChoices,
} from '../src/providers/catalog.js';
import {addChoiceRow} from './choiceRow.js';
import {REFRESH_INTERVAL_CHOICES} from './choices.js';

function addProviderSpecificGroups(
    page, settings, providerChoices, _, addCleanup) {
    const seenProviderIds = new Set();
    for (const provider of providerChoices) {
        if (seenProviderIds.has(provider.value))
            continue;
        seenProviderIds.add(provider.value);
        const preferences = getProviderPreferences(provider.value);
        if (preferences.length === 0)
            continue;

        const group = new Adw.PreferencesGroup({title: _(provider.label)});
        for (const preference of preferences) {
            if (preference.type !== 'choice')
                throw new Error(`Unsupported preference type "${preference.type}"`);
            addChoiceRow({
                group,
                settings,
                key: preference.key,
                title: preference.title,
                choices: preference.choices,
                _,
                addCleanup,
            });
        }

        const updateVisibility = () => {
            group.visible = settings.get_string('fx-provider') === provider.value ||
                settings.get_string('gold-provider') === provider.value;
        };
        const fxSignalId = settings.connect(
            'changed::fx-provider', updateVisibility);
        const goldSignalId = settings.connect(
            'changed::gold-provider', updateVisibility);
        addCleanup(() => {
            settings.disconnect(fxSignalId);
            settings.disconnect(goldSignalId);
        });
        updateVisibility();
        page.add(group);
    }
}

export function createProviderSettingsPage(settings, _, addCleanup) {
    const page = new Adw.PreferencesPage({
        title: _('Data Sources'),
        icon_name: 'network-server-symbolic',
    });
    const group = new Adw.PreferencesGroup({title: _('Providers')});
    const fxChoices = listProviderChoices('currencies');
    const goldChoices = listProviderChoices('metals');

    addChoiceRow({
        group,
        settings,
        key: 'fx-provider',
        title: 'Currency provider',
        choices: fxChoices,
        _,
        addCleanup,
    });
    addChoiceRow({
        group,
        settings,
        key: 'gold-provider',
        title: 'Gold provider',
        choices: goldChoices,
        _,
        addCleanup,
    });
    addChoiceRow({
        group,
        settings,
        key: 'refresh-interval',
        title: 'Refresh interval',
        choices: REFRESH_INTERVAL_CHOICES,
        _,
        addCleanup,
    });
    page.add(group);
    addProviderSpecificGroups(
        page, settings, [...fxChoices, ...goldChoices], _, addCleanup);
    return page;
}
