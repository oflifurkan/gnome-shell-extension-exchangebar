import {CancellationError, ProviderUnavailableError} from '../core/errors.js';
import {createCommodityQuote, createCurrencyQuote} from '../core/quote.js';
import {Provider} from './provider.js';

export class FakeProvider extends Provider {
    static metadata = Object.freeze({
        id: 'fake',
        name: 'Fake Provider',
        capabilities: Object.freeze({
            currencies: true,
            metals: true,
            bidAsk: false,
            historical: false,
        }),
        authentication: Object.freeze({apiKey: false}),
        defaultRefreshInterval: 600,
    });

    constructor({clock = () => Math.floor(Date.now() / 1000)} = {}) {
        super(FakeProvider.metadata);
        this._clock = clock;
        this._disposed = false;
    }

    async fetchQuotes({fx = false, gold = false} = {}, cancellable = null) {
        await Promise.resolve();
        if (cancellable?.is_cancelled())
            throw new CancellationError('Request was cancelled');
        if (this._disposed)
            throw new ProviderUnavailableError('Fake Provider has been disposed');

        const timestamp = this._clock();
        const common = {
            timestamp,
            provider: this.metadata.id,
            stale: false,
        };
        const quotes = [];

        if (fx) {
            quotes.push(createCurrencyQuote({
                ...common,
                id: 'USDTRY',
                base: 'USD',
                quote: 'TRY',
                value: 48.47,
            }));
            quotes.push(createCurrencyQuote({
                ...common,
                id: 'EURTRY',
                base: 'EUR',
                quote: 'TRY',
                value: 56.37,
            }));
        }

        if (gold) {
            quotes.push(createCommodityQuote({
                ...common,
                id: 'GOLD_GRAM_TRY',
                asset: 'GOLD',
                currency: 'TRY',
                unit: 'GRAM',
                value: 5421,
            }));
        }

        return quotes;
    }

    dispose() {
        this._disposed = true;
        this._clock = null;
    }
}
