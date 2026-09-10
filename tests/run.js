import Gio from 'gi://Gio';

import {CancellationError, InvalidResponseError, NetworkError, ProviderUnavailableError} from '../src/core/errors.js';
import {MarketService} from '../src/core/marketService.js';
import {ProviderRegistry} from '../src/core/providerRegistry.js';
import {createCommodityQuote, createCurrencyQuote, createMarketSnapshot} from '../src/core/quote.js';
import {FakeProvider} from '../src/providers/fakeProvider.js';
import {formatPanelQuote} from '../src/ui/format.js';

let passed = 0;

function assert(condition, message = 'Assertion failed') {
    if (!condition)
        throw new Error(message);
}

function assertEqual(actual, expected, message = '') {
    if (actual !== expected)
        throw new Error(`${message} expected ${expected}, got ${actual}`);
}

function assertThrows(callback, ErrorType) {
    try {
        callback();
    } catch (error) {
        assert(error instanceof ErrorType,
            `Expected ${ErrorType.name}, got ${error.constructor.name}`);
        return;
    }
    throw new Error(`Expected ${ErrorType.name} to be thrown`);
}

async function test(name, callback) {
    try {
        await callback();
        passed++;
        print(`ok - ${name}`);
    } catch (error) {
        printerr(`not ok - ${name}: ${error.stack ?? error.message}`);
        throw error;
    }
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (predicate())
            return;
        await Promise.resolve();
    }
    throw new Error(message);
}

class FakeSettings {
    constructor(values = {}) {
        this._values = {
            'fx-provider': 'fake',
            'gold-provider': 'fake',
            ...values,
        };
        this._signals = new Map();
        this._nextId = 1;
    }

    get_string(key) {
        return this._values[key];
    }

    connect(signal, callback) {
        const id = this._nextId++;
        this._signals.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this._signals.delete(id);
    }

    set_string(key, value) {
        this._values[key] = value;
        for (const entry of this._signals.values()) {
            if (entry.signal === `changed::${key}`)
                entry.callback();
        }
    }
}

function createRegistry(clock = () => 1000) {
    const registry = new ProviderRegistry();
    registry.register(FakeProvider.metadata,
        context => new FakeProvider({...context, clock}));
    return registry;
}

function testMetadata(id) {
    return {
        id,
        name: `Provider ${id}`,
        capabilities: {currencies: true, metals: true},
        authentication: {apiKey: false},
        defaultRefreshInterval: 600,
    };
}

class TestProvider {
    constructor(id, tracker, {fail = false} = {}) {
        this.metadata = testMetadata(id);
        this._id = id;
        this._tracker = tracker;
        this.fail = fail;
        this.disposed = false;
    }

    async fetchQuotes(request) {
        this._tracker.push({...request});
        if (this.fail)
            throw new NetworkError('Test network failure');
        const common = {
            timestamp: 1000,
            provider: this._id,
            stale: false,
        };
        const quotes = [];
        if (request.fx) {
            quotes.push(createCurrencyQuote({
                ...common, id: 'USDTRY', base: 'USD', quote: 'TRY', value: 48,
            }));
            quotes.push(createCurrencyQuote({
                ...common, id: 'EURTRY', base: 'EUR', quote: 'TRY', value: 56,
            }));
        }
        if (request.gold) {
            quotes.push(createCommodityQuote({
                ...common, id: 'GOLD_GRAM_TRY', asset: 'GOLD', currency: 'TRY',
                unit: 'GRAM', value: 5400,
            }));
        }
        return quotes;
    }

    dispose() {
        this.disposed = true;
    }
}

await test('quote factories preserve normalized, unit-aware data', () => {
    const currency = createCurrencyQuote({
        id: 'USDTRY', base: 'USD', quote: 'TRY', value: 48.47,
        timestamp: 1000, provider: 'fake', stale: false,
    });
    const gold = createCommodityQuote({
        id: 'GOLD_GRAM_TRY', asset: 'GOLD', currency: 'TRY', unit: 'GRAM',
        value: 5421, timestamp: 1000, provider: 'fake', stale: false,
    });
    assert(Object.isFrozen(currency));
    assertEqual(currency.bid, null);
    assertEqual(gold.unit, 'GRAM');
    assertEqual(createMarketSnapshot([currency, gold]).updatedAt, 1000);
});

await test('quote factories reject invalid values and duplicate IDs', () => {
    assertThrows(() => createCurrencyQuote({
        id: 'USDTRY', base: 'USD', quote: 'TRY', value: 0,
        timestamp: 1000, provider: 'fake', stale: false,
    }), InvalidResponseError);
    const quote = createCurrencyQuote({
        id: 'USDTRY', base: 'USD', quote: 'TRY', value: 1,
        timestamp: 1000, provider: 'fake', stale: false,
    });
    assertThrows(() => createMarketSnapshot([quote, quote]), InvalidResponseError);
});

await test('registry creates providers and filters capabilities', () => {
    const registry = createRegistry();
    assertEqual(registry.create('fake').metadata.name, 'Fake Provider');
    assertEqual(registry.list('metals').length, 1);
    assertThrows(() => registry.create('missing'), ProviderUnavailableError);
    assertThrows(() => registry.register(FakeProvider.metadata, () => null), TypeError);
});

await test('fake provider returns exact normalized quotes', async () => {
    const provider = new FakeProvider({clock: () => 1789048320});
    const quotes = await provider.fetchQuotes({fx: true, gold: true});
    assertEqual(quotes.length, 3);
    assertEqual(quotes.find(quote => quote.id === 'USDTRY').value, 48.47);
    assertEqual(quotes.find(quote => quote.id === 'EURTRY').value, 56.37);
    assertEqual(quotes.find(quote => quote.id === 'GOLD_GRAM_TRY').value, 5421);
    assert(quotes.every(quote => quote.timestamp === 1789048320));
});

await test('fake provider honors cancellation and disposal', async () => {
    const cancelled = new Gio.Cancellable();
    cancelled.cancel();
    const provider = new FakeProvider();
    try {
        await provider.fetchQuotes({fx: true}, cancelled);
        throw new Error('Expected cancellation');
    } catch (error) {
        assert(error instanceof CancellationError);
    }
    provider.dispose();
    try {
        await provider.fetchQuotes({fx: true});
        throw new Error('Expected disposal error');
    } catch (error) {
        assert(error instanceof ProviderUnavailableError);
    }
});

await test('market service produces and exposes a complete snapshot', async () => {
    const service = new MarketService({
        settings: new FakeSettings(),
        registry: createRegistry(),
    });
    await service.start();
    assertEqual(service.status, 'ready');
    assertEqual(Object.keys(service.getSnapshot().quotes).length, 3);
    assertEqual(service.getQuote('USDTRY').value, 48.47);
    assertEqual(service.getProviderName('fake'), 'Fake Provider');
    service.destroy();
    service.destroy();
});

await test('market service deduplicates an active refresh', async () => {
    const service = new MarketService({
        settings: new FakeSettings(),
        registry: createRegistry(),
    });
    const first = service.refresh();
    const second = service.refresh();
    assert(first === second);
    await first;
    service.destroy();
});

await test('market service coalesces roles using the same provider', async () => {
    const tracker = [];
    const registry = new ProviderRegistry();
    registry.register(testMetadata('shared'),
        () => new TestProvider('shared', tracker));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'shared',
            'gold-provider': 'shared',
        }),
        registry,
    });
    await service.start();
    assertEqual(tracker.length, 1);
    assert(tracker[0].fx && tracker[0].gold);
    service.destroy();
});

await test('market service keeps FX and gold providers independent', async () => {
    const fxTracker = [];
    const goldTracker = [];
    const registry = new ProviderRegistry();
    registry.register(testMetadata('fx-source'),
        () => new TestProvider('fx-source', fxTracker));
    registry.register(testMetadata('gold-source'),
        () => new TestProvider('gold-source', goldTracker));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'fx-source',
            'gold-provider': 'gold-source',
        }),
        registry,
    });
    await service.start();
    assertEqual(service.getQuote('USDTRY').provider, 'fx-source');
    assertEqual(service.getQuote('GOLD_GRAM_TRY').provider, 'gold-source');
    assert(fxTracker[0].fx && !fxTracker[0].gold);
    assert(!goldTracker[0].fx && goldTracker[0].gold);
    service.destroy();
});

await test('market service retains the last snapshot after an error', async () => {
    const tracker = [];
    let provider;
    const registry = new ProviderRegistry();
    registry.register(testMetadata('fallible'), () => {
        provider = new TestProvider('fallible', tracker);
        return provider;
    });
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'fallible',
            'gold-provider': 'fallible',
        }),
        registry,
    });
    await service.start();
    const snapshot = service.getSnapshot();
    provider.fail = true;
    await service.refresh();
    assertEqual(service.status, 'error');
    assert(service.lastError instanceof NetworkError);
    assert(service.getSnapshot() === snapshot);
    service.destroy();
});

await test('provider setting changes replace and dispose providers', async () => {
    const oldTracker = [];
    const newTracker = [];
    let oldProvider;
    const registry = new ProviderRegistry();
    registry.register(testMetadata('old'), () => {
        oldProvider = new TestProvider('old', oldTracker);
        return oldProvider;
    });
    registry.register(testMetadata('new'),
        () => new TestProvider('new', newTracker));
    const settings = new FakeSettings({
        'fx-provider': 'old',
        'gold-provider': 'old',
    });
    const service = new MarketService({settings, registry});
    await service.start();

    settings.set_string('fx-provider', 'new');
    await waitFor(() => service.getQuote('USDTRY')?.provider === 'new',
        'FX provider was not replaced');
    assertEqual(service.getQuote('GOLD_GRAM_TRY').provider, 'old');
    assert(!oldProvider.disposed);

    settings.set_string('gold-provider', 'new');
    await waitFor(() => service.getQuote('GOLD_GRAM_TRY')?.provider === 'new',
        'Gold provider was not replaced');
    assert(oldProvider.disposed);
    service.destroy();
});

await test('panel formatter uses instrument prefixes and precision', () => {
    const usd = formatPanelQuote('USDTRY', 48.47, 2);
    const gold = formatPanelQuote('GOLD_GRAM_TRY', 5421, 0);
    assert(usd.startsWith('$48'));
    assert(gold.startsWith('Au '));
});

print(`1..${passed}`);
