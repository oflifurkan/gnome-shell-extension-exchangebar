import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {formatPanelQuote} from './format.js';
import {MarketMenu} from './marketMenu.js';

const PANEL_ITEMS = Object.freeze([
    {id: 'USDTRY', setting: 'show-usd', precision: 'currency-precision'},
    {id: 'EURTRY', setting: 'show-eur', precision: 'currency-precision'},
    {id: 'GOLD_GRAM_TRY', setting: 'show-gold', precision: 'gold-precision'},
]);

export const ExchangeBarIndicator = GObject.registerClass(
class ExchangeBarIndicator extends PanelMenu.Button {
    constructor(service, settings, _) {
        super(0.5, _('ExchangeBar'));
        this._service = service;
        this._settings = settings;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box exchangebar-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);
        this._labels = new Map();
        for (const item of PANEL_ITEMS) {
            const label = new St.Label({
                text: '—',
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.add_style_class_name('exchangebar-panel-value');
            this._box.add_child(label);
            this._labels.set(item.id, label);
        }

        this._menuView = new MarketMenu(this.menu, service, _);
        this._serviceSubscription = service.subscribe(() => this._render());
        this._settingsSignalIds = [];
        for (const key of [
            'show-usd', 'show-eur', 'show-gold',
            'currency-precision', 'gold-precision',
        ]) {
            this._settingsSignalIds.push(settings.connect(`changed::${key}`,
                () => this._render()));
        }
        this._menuSignalId = this.menu.connect('open-state-changed',
            (_menu, open) => {
                if (open)
                    this._menuView.render();
            });
        this._render();
    }

    _render() {
        for (const item of PANEL_ITEMS) {
            const label = this._labels.get(item.id);
            label.visible = this._settings.get_boolean(item.setting);
            const quote = this._service.getQuote(item.id);
            const precision = this._settings.get_uint(item.precision);
            label.text = quote
                ? formatPanelQuote(item.id, quote.value, precision)
                : '—';
            if (quote?.stale)
                label.add_style_class_name('exchangebar-stale');
            else
                label.remove_style_class_name('exchangebar-stale');
        }
        this._menuView.render();
    }

    destroy() {
        if (this._serviceSubscription) {
            this._service.unsubscribe(this._serviceSubscription);
            this._serviceSubscription = 0;
        }
        for (const id of this._settingsSignalIds ?? [])
            this._settings.disconnect(id);
        this._settingsSignalIds = [];
        if (this._menuSignalId) {
            this.menu.disconnect(this._menuSignalId);
            this._menuSignalId = 0;
        }
        this._menuView?.destroy();
        this._menuView = null;
        this._labels?.clear();
        this._service = null;
        this._settings = null;
        super.destroy();
    }
});
