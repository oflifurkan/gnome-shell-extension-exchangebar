import Adw from 'gi://Adw';

export function createProviderSettingsGroup(_) {
    const group = new Adw.PreferencesGroup({title: _('Data Sources')});
    group.add(new Adw.ActionRow({
        title: _('Currency provider'),
        subtitle: _('Fake Provider'),
    }));
    group.add(new Adw.ActionRow({
        title: _('Gold provider'),
        subtitle: _('XAUS'),
    }));
    group.add(new Adw.ActionRow({
        title: _('Refresh interval'),
        subtitle: _('10 minutes'),
    }));
    return group;
}
