import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatTry} from './format.js';

const QUOTE_ROWS = Object.freeze([
    {id: 'USDTRY', label: 'USD / TRY', precision: 4},
    {id: 'EURTRY', label: 'EUR / TRY', precision: 4},
    {id: 'GOLD_GRAM_TRY', label: 'Gram Gold', precision: 2},
]);

function relativeUpdate(timestamp, _) {
    if (timestamp === null)
        return _('Waiting for data');
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
    if (seconds < 60)
        return _('Updated just now');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return _('Updated %d minutes ago').replace('%d', String(minutes));
    const hours = Math.floor(minutes / 60);
    return _('Updated %d hours ago').replace('%d', String(hours));
}

export class MarketMenu {
    constructor(menu, service, _) {
        this._menu = menu;
        this._service = service;
        this._ = _;

        const title = new PopupMenu.PopupMenuItem(_('ExchangeBar'), {
            reactive: false,
        });
        title.label.add_style_class_name('exchangebar-menu-title');
        menu.addMenuItem(title);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rows = new Map();
        for (const spec of QUOTE_ROWS) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            item.add_style_class_name('exchangebar-quote-row');
            const name = new St.Label({
                text: _(spec.label),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            name.add_style_class_name('exchangebar-quote-name');
            const value = new St.Label({
                text: '—',
                y_align: Clutter.ActorAlign.CENTER,
            });
            value.add_style_class_name('exchangebar-quote-value');
            item.add_child(name);
            item.add_child(value);
            menu.addMenuItem(item);
            this._rows.set(spec.id, {item, name, value, spec});
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._updatedItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._updatedItem.label.add_style_class_name('exchangebar-menu-meta');
        menu.addMenuItem(this._updatedItem);
        this._providerItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._providerItem.label.add_style_class_name('exchangebar-menu-meta');
        menu.addMenuItem(this._providerItem);
        this._errorItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._errorItem.label.add_style_class_name('exchangebar-menu-error');
        menu.addMenuItem(this._errorItem);
    }

    render() {
        const snapshot = this._service.getSnapshot();
        const providerIds = new Set(Object.values(snapshot.quotes)
            .map(quote => quote.provider));

        for (const [id, row] of this._rows) {
            const quote = snapshot.quotes[id];
            row.value.text = quote
                ? formatTry(quote.value, row.spec.precision)
                : '—';
            const providerSuffix = providerIds.size > 1 && quote
                ? ` · ${this._service.getProviderName(quote.provider)}`
                : '';
            row.name.text = `${this._(row.spec.label)}${providerSuffix}`;
        }

        this._updatedItem.label.text = relativeUpdate(snapshot.updatedAt, this._);
        const providers = [...providerIds]
            .map(id => this._service.getProviderName(id));
        this._providerItem.label.text = providers.length === 1
            ? providers[0]
            : providers.join(' · ');
        this._providerItem.visible = providers.length > 0;

        this._errorItem.visible = this._service.status === 'error';
        this._errorItem.label.text = this._service.lastError
            ? this._('Unable to update: %s')
                .replace('%s', this._service.lastError.message)
            : '';
    }

    destroy() {
        this._rows.clear();
        this._menu = null;
        this._service = null;
        this._ = null;
    }
}
