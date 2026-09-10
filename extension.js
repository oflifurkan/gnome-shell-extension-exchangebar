import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MarketCache} from './src/core/cache.js';
import {MarketService} from './src/core/marketService.js';
import {createProviderRegistry} from './src/providers/catalog.js';
import {ExchangeBarIndicator} from './src/ui/indicator.js';
import {getPanelPlacement} from './src/ui/panelPlacement.js';

export default class ExchangeBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const registry = createProviderRegistry();

        this._marketService = new MarketService({
            settings: this._settings,
            registry,
            providerContext: {settings: this._settings},
            cache: new MarketCache(),
        });

        this._recreateIndicator();
        this._panelPositionSignalId = this._settings.connect(
            'changed::panel-position', () => this._recreateIndicator());
        void this._marketService.start();
    }

    disable() {
        if (this._panelPositionSignalId) {
            this._settings.disconnect(this._panelPositionSignalId);
            this._panelPositionSignalId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._marketService?.destroy();
        this._marketService = null;
        this._settings = null;
    }

    _recreateIndicator() {
        this._indicator?.destroy();
        this._indicator = new ExchangeBarIndicator(
            this._marketService, this._settings, this.gettext.bind(this));

        const placement = getPanelPlacement(
            this._settings.get_string('panel-position'));
        Main.panel.addToStatusArea(
            this.uuid, this._indicator, placement.position, placement.box);
    }
}
