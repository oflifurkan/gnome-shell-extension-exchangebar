import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MarketCache} from './src/core/cache.js';
import {MarketService} from './src/core/marketService.js';
import {createProviderRegistry} from './src/providers/catalog.js';
import {ExchangeBarIndicator} from './src/ui/indicator.js';

export default class ExchangeBarExtension extends Extension {
    enable() {
        const settings = this.getSettings();
        const registry = createProviderRegistry();

        this._marketService = new MarketService({
            settings,
            registry,
            providerContext: {settings},
            cache: new MarketCache(),
        });
        this._indicator = new ExchangeBarIndicator(
            this._marketService, settings, this.gettext.bind(this));

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        void this._marketService.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;

        this._marketService?.destroy();
        this._marketService = null;
    }
}
