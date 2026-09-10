import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MarketService} from './src/core/marketService.js';
import {ProviderRegistry} from './src/core/providerRegistry.js';
import {FakeProvider} from './src/providers/fakeProvider.js';
import {XausProvider} from './src/providers/xaus.js';
import {ExchangeBarIndicator} from './src/ui/indicator.js';

export default class ExchangeBarExtension extends Extension {
    enable() {
        const settings = this.getSettings();
        const registry = new ProviderRegistry();
        registry.register(FakeProvider.metadata,
            context => new FakeProvider(context));
        registry.register(XausProvider.metadata,
            context => new XausProvider(context));

        this._marketService = new MarketService({settings, registry});
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
