import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    ConverterAsset,
    convert,
    convertAll,
    parseAmount,
} from '../src/core/converter.js';
import {
    CancellationError,
    InvalidAmountError,
    InvalidResponseError,
    MissingQuoteError,
    NetworkError,
    ProviderUnavailableError,
    RateLimitError,
    UnsupportedAssetError,
} from '../src/core/errors.js';
import {MarketService, REFRESH_INTERVALS} from '../src/core/marketService.js';
import {ProviderRegistry} from '../src/core/providerRegistry.js';
import {createCommodityQuote, createCurrencyQuote, createMarketSnapshot} from '../src/core/quote.js';
import {FakeProvider} from '../src/providers/fakeProvider.js';
import {SoupHttpClient} from '../src/providers/httpClient.js';
import {
    MAX_FRESH_AGE_SECONDS,
    XAUS_ENDPOINT,
    XausProvider,
    parseXausSpot,
    translateXausHttpError,
} from '../src/providers/xaus.js';
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

async function assertRejects(callback, ErrorType) {
    try {
        await callback();
    } catch (error) {
        assert(error instanceof ErrorType,
            `Expected ${ErrorType.name}, got ${error.constructor.name}`);
        return error;
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
            'refresh-interval': 600,
            ...values,
        };
        this._signals = new Map();
        this._nextId = 1;
    }

    get_string(key) {
        return this._values[key];
    }

    get_uint(key) {
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
        this._set(key, value);
    }

    set_uint(key, value) {
        this._set(key, value);
    }

    _set(key, value) {
        this._values[key] = value;
        for (const entry of this._signals.values()) {
            if (entry.signal === `changed::${key}`)
                entry.callback();
        }
    }
}

class FakeScheduler {
    constructor() {
        this._nextId = 1;
        this.active = new Map();
        this.scheduled = [];
        this.cancelled = [];
    }

    scheduleSeconds(delay, callback) {
        const id = this._nextId++;
        this.active.set(id, callback);
        this.scheduled.push({id, delay});
        return id;
    }

    cancel(id) {
        this.cancelled.push(id);
        this.active.delete(id);
    }

    fire(id) {
        const callback = this.active.get(id);
        if (!callback)
            throw new Error(`Timer ${id} is not active`);
        this.active.delete(id);
        callback();
    }
}

function createRegistry(clock = () => 1000) {
    const registry = new ProviderRegistry();
    registry.register(FakeProvider.metadata,
        context => new FakeProvider({...context, clock}));
    return registry;
}

function loadJsonFixture(path) {
    const filename = GLib.build_filenamev([
        GLib.get_current_dir(), 'tests', 'fixtures', ...path.split('/'),
    ]);
    const [success, contents] = GLib.file_get_contents(filename);
    if (!success)
        throw new Error(`Unable to read fixture ${filename}`);
    return JSON.parse(new TextDecoder().decode(contents));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class StubHttpClient {
    constructor(response) {
        this.response = response;
        this.calls = [];
    }

    async get(url, cancellable) {
        this.calls.push({url, cancellable});
        if (this.response instanceof Error)
            throw this.response;
        return this.response;
    }
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

class DeferredProvider extends TestProvider {
    async fetchQuotes(request, cancellable) {
        this._tracker.push({...request});
        this.cancellable = cancellable;
        const quotes = await new Promise(resolve => {
            this.release = resolve;
        });
        return quotes;
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

function converterQuotes() {
    return createMarketSnapshot([
        createCurrencyQuote({
            id: 'USDTRY', base: 'USD', quote: 'TRY', value: 48.47,
            timestamp: 1000, provider: 'fake', stale: false,
        }),
        createCurrencyQuote({
            id: 'EURTRY', base: 'EUR', quote: 'TRY', value: 56.37,
            timestamp: 1000, provider: 'fake', stale: false,
        }),
        createCommodityQuote({
            id: 'GOLD_GRAM_TRY', asset: 'GOLD', currency: 'TRY', unit: 'GRAM',
            value: 5421, timestamp: 1000, provider: 'fake', stale: false,
        }),
    ]).quotes;
}

function assertClose(actual, expected, tolerance = 1e-9) {
    assert(Math.abs(actual - expected) <= tolerance,
        `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

await test('converter parses dot and comma decimal input', () => {
    assertEqual(parseAmount('1000'), 1000);
    assertEqual(parseAmount(' 12.5 '), 12.5);
    assertEqual(parseAmount('12,5'), 12.5);
    assertEqual(parseAmount(',25'), 0.25);
    assertEqual(parseAmount('0'), 0);
});

await test('converter rejects invalid and grouped input', () => {
    for (const input of ['', '-1', '1e3', '1,000.00', '1.2.3',
        '1 000', 'NaN', 'Infinity']) {
        assertThrows(() => parseAmount(input), InvalidAmountError);
    }
});

await test('converter calculates TRY-normalized values in every direction', () => {
    const quotes = converterQuotes();
    assertClose(convert(1000, ConverterAsset.TRY, ConverterAsset.USD, quotes),
        1000 / 48.47);
    assertClose(convert(1, ConverterAsset.USD, ConverterAsset.TRY, quotes),
        48.47);
    assertClose(convert(1, ConverterAsset.USD, ConverterAsset.EUR, quotes),
        48.47 / 56.37);
    assertClose(convert(1, ConverterAsset.GOLD_GRAM, ConverterAsset.USD, quotes),
        5421 / 48.47);
    assertClose(convert(3, ConverterAsset.EUR, ConverterAsset.EUR, {}), 3);
    assertEqual(convert(0, ConverterAsset.TRY, ConverterAsset.USD, quotes), 0);
});

await test('convertAll returns every other asset in stable order', () => {
    const results = convertAll(1000, ConverterAsset.TRY, converterQuotes());
    assertEqual(results.length, 3);
    assertEqual(results[0].asset, ConverterAsset.USD);
    assertEqual(results[1].asset, ConverterAsset.EUR);
    assertEqual(results[2].asset, ConverterAsset.GOLD_GRAM);
    assertClose(results[0].value, 20.631318341241);
    assertClose(results[1].value, 17.739932588256);
    assertClose(results[2].value, 0.184467810367);
});

await test('converter reports missing quotes and unsupported assets', () => {
    assertThrows(() => convert(
        1, ConverterAsset.TRY, ConverterAsset.USD, {}), MissingQuoteError);
    assertThrows(() => convert(
        1, 'BTC', ConverterAsset.TRY, converterQuotes()), UnsupportedAssetError);
    assertThrows(() => convert(
        -1, ConverterAsset.TRY, ConverterAsset.USD, converterQuotes()),
    InvalidAmountError);
});

const XAUS_FIXTURE_TIME = Math.floor(
    Date.parse('2026-09-10T15:00:20.000Z') / 1000);

await test('XAUS parser creates unit-aware gram and XAU/USD quotes', () => {
    const payload = loadJsonFixture('xaus/spot-fresh.json');
    const quotes = parseXausSpot(payload, {clock: () => XAUS_FIXTURE_TIME});
    assertEqual(quotes.length, 2);

    const gram = quotes.find(quote => quote.id === 'GOLD_GRAM_TRY');
    assertEqual(gram.value, 5912.3478);
    assertEqual(gram.asset, 'GOLD');
    assertEqual(gram.currency, 'TRY');
    assertEqual(gram.unit, 'GRAM');
    assertEqual(gram.provider, 'xaus');
    assertEqual(gram.stale, false);

    const ounce = quotes.find(quote => quote.id === 'XAUUSD');
    assertEqual(ounce.value, 4416.2);
    assertEqual(ounce.currency, 'USD');
    assertEqual(ounce.unit, 'TROY_OUNCE');
    assertEqual(ounce.timestamp,
        Math.floor(Date.parse('2026-09-10T15:00:00.000Z') / 1000));
    assertEqual(ounce.stale, false);
});

await test('XAUS parser tracks gold and FX staleness independently', () => {
    const fxStale = loadJsonFixture('xaus/spot-fx-stale.json');
    const quotes = parseXausSpot(fxStale, {clock: () => XAUS_FIXTURE_TIME});
    assertEqual(quotes.find(quote => quote.id === 'GOLD_GRAM_TRY').stale, true);
    assertEqual(quotes.find(quote => quote.id === 'XAUUSD').stale, false);

    const goldStale = clone(loadJsonFixture('xaus/spot-fresh.json'));
    goldStale.data_state.status = 'stale';
    const staleQuotes = parseXausSpot(
        goldStale, {clock: () => XAUS_FIXTURE_TIME});
    assert(staleQuotes.every(quote => quote.stale));

    const oldQuotes = parseXausSpot(
        loadJsonFixture('xaus/spot-fresh.json'),
        {clock: () => XAUS_FIXTURE_TIME + MAX_FRESH_AGE_SECONDS + 1});
    assert(oldQuotes.every(quote => quote.stale));
});

await test('XAUS parser rejects unavailable and malformed market data', () => {
    assertThrows(() => parseXausSpot(
        loadJsonFixture('xaus/unavailable.json')),
    ProviderUnavailableError);

    const valid = loadJsonFixture('xaus/spot-fresh.json');
    for (const mutate of [
        value => value.xau.currency = 'USD',
        value => value.xau.unit = 'kg',
        value => value.xau.price = 0,
        value => value.spot_usd_oz = -1,
        value => value.data_state.status = 'unknown',
        value => value.data_state.as_of = 'not-a-date',
    ]) {
        const payload = clone(valid);
        mutate(payload);
        assertThrows(() => parseXausSpot(
            payload, {clock: () => XAUS_FIXTURE_TIME}), InvalidResponseError);
    }
});

await test('XAUS HTTP errors map to common provider errors', () => {
    assert(translateXausHttpError(400) instanceof InvalidResponseError);
    assert(translateXausHttpError(405) instanceof InvalidResponseError);
    assert(translateXausHttpError(429) instanceof RateLimitError);
    assert(translateXausHttpError(503) instanceof ProviderUnavailableError);
    assert(translateXausHttpError(418) instanceof NetworkError);
});

await test('XAUS provider performs one keyless cancellable request', async () => {
    const fixture = loadJsonFixture('xaus/spot-fresh.json');
    const httpClient = new StubHttpClient({
        status: 200,
        body: JSON.stringify(fixture),
    });
    const provider = new XausProvider({
        httpClient,
        clock: () => XAUS_FIXTURE_TIME,
    });
    const cancellable = new Gio.Cancellable();
    const quotes = await provider.fetchQuotes({gold: true}, cancellable);
    assertEqual(quotes.length, 2);
    assertEqual(httpClient.calls.length, 1);
    assertEqual(httpClient.calls[0].url, XAUS_ENDPOINT);
    assert(httpClient.calls[0].cancellable === cancellable);
    assertEqual((await provider.fetchQuotes({})).length, 0);
    assertEqual(httpClient.calls.length, 1);
    await assertRejects(() => provider.fetchQuotes({fx: true}),
        ProviderUnavailableError);
    provider.dispose();
    provider.dispose();
    await assertRejects(() => provider.fetchQuotes({gold: true}),
        ProviderUnavailableError);
});

await test('XAUS provider translates malformed and unavailable responses', async () => {
    const malformed = new XausProvider({
        httpClient: new StubHttpClient({status: 200, body: '{broken'}),
    });
    await assertRejects(() => malformed.fetchQuotes({gold: true}),
        InvalidResponseError);
    malformed.dispose();

    const unavailable = new XausProvider({
        httpClient: new StubHttpClient({
            status: 503,
            body: JSON.stringify(loadJsonFixture('xaus/unavailable.json')),
        }),
    });
    await assertRejects(() => unavailable.fetchQuotes({gold: true}),
        ProviderUnavailableError);
    unavailable.dispose();
});

await test('market service combines Fake FX with XAUS gold', async () => {
    const registry = createRegistry(() => XAUS_FIXTURE_TIME);
    registry.register(XausProvider.metadata, () => new XausProvider({
        httpClient: new StubHttpClient({
            status: 200,
            body: JSON.stringify(loadJsonFixture('xaus/spot-fresh.json')),
        }),
        clock: () => XAUS_FIXTURE_TIME,
    }));
    const service = new MarketService({
        settings: new FakeSettings({'gold-provider': 'xaus'}),
        registry,
    });
    await service.start();
    assertEqual(service.status, 'ready');
    assertEqual(service.getQuote('USDTRY').provider, 'fake');
    assertEqual(service.getQuote('GOLD_GRAM_TRY').provider, 'xaus');
    assertEqual(service.getQuote('XAUUSD').provider, 'xaus');
    service.destroy();
});

await test('market service rejects provider capability mismatches', async () => {
    const registry = createRegistry();
    registry.register(XausProvider.metadata, () => new XausProvider({
        httpClient: new StubHttpClient(new Error('Must not be called')),
    }));
    const service = new MarketService({
        settings: new FakeSettings({'fx-provider': 'xaus'}),
        registry,
    });
    await service.start();
    assertEqual(service.status, 'error');
    assert(service.lastError instanceof ProviderUnavailableError);
    service.destroy();
});

await test('disposed Soup HTTP clients reject without network access', async () => {
    const client = new SoupHttpClient();
    client.dispose();
    client.dispose();
    await assertRejects(() => client.get('https://example.invalid'), NetworkError);
});

await test('market service schedules refresh after startup and manual refresh', async () => {
    const scheduler = new FakeScheduler();
    const service = new MarketService({
        settings: new FakeSettings(),
        registry: createRegistry(),
        scheduler,
    });
    const refreshingStates = [];
    service.subscribe(current => refreshingStates.push(current.isRefreshing));
    await service.start();
    assertEqual(scheduler.scheduled.length, 1);
    assertEqual(scheduler.scheduled[0].delay, 600);
    assertEqual(scheduler.active.size, 1);

    const firstTimer = scheduler.scheduled[0].id;
    await service.refresh();
    assert(scheduler.cancelled.includes(firstTimer));
    assertEqual(scheduler.scheduled.length, 2);
    assertEqual(scheduler.active.size, 1);
    assert(refreshingStates.includes(true));
    assertEqual(refreshingStates.at(-1), false);
    service.destroy();
});

await test('automatic timer refreshes once and schedules from completion', async () => {
    const tracker = [];
    const scheduler = new FakeScheduler();
    const registry = new ProviderRegistry();
    registry.register(testMetadata('scheduled'),
        () => new TestProvider('scheduled', tracker));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'scheduled',
            'gold-provider': 'scheduled',
        }),
        registry,
        scheduler,
    });
    await service.start();
    assertEqual(tracker.length, 1);
    const timerId = scheduler.scheduled[0].id;
    scheduler.fire(timerId);
    assertEqual(scheduler.active.size, 0);
    await waitFor(() => tracker.length === 2 && scheduler.active.size === 1,
        'Automatic refresh did not complete and reschedule');
    assertEqual(scheduler.scheduled.length, 2);
    service.destroy();
});

await test('refresh failures keep retry scheduling active', async () => {
    const scheduler = new FakeScheduler();
    const registry = new ProviderRegistry();
    registry.register(testMetadata('offline'),
        () => new TestProvider('offline', [], {fail: true}));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'offline',
            'gold-provider': 'offline',
        }),
        registry,
        scheduler,
    });
    await service.start();
    assertEqual(service.status, 'error');
    assertEqual(service.isRefreshing, false);
    assertEqual(scheduler.active.size, 1);
    service.destroy();
});

await test('refresh interval changes replace the pending timer', async () => {
    const settings = new FakeSettings();
    const scheduler = new FakeScheduler();
    const service = new MarketService({
        settings,
        registry: createRegistry(),
        scheduler,
    });
    await service.start();
    const firstTimer = scheduler.scheduled[0].id;
    settings.set_uint('refresh-interval', 900);
    assert(scheduler.cancelled.includes(firstTimer));
    assertEqual(scheduler.scheduled.at(-1).delay, 900);
    assert(REFRESH_INTERVALS.includes(scheduler.scheduled.at(-1).delay));

    settings.set_uint('refresh-interval', 601);
    assertEqual(scheduler.scheduled.at(-1).delay, 600);
    service.destroy();
});

await test('destroy cancels pending work without late callbacks or timers', async () => {
    const tracker = [];
    const scheduler = new FakeScheduler();
    let provider;
    const registry = new ProviderRegistry();
    registry.register(testMetadata('deferred'), () => {
        provider = new DeferredProvider('deferred', tracker);
        return provider;
    });
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'deferred',
            'gold-provider': 'deferred',
        }),
        registry,
        scheduler,
    });
    let notificationCount = 0;
    service.subscribe(() => notificationCount++);
    const startPromise = service.start();
    await waitFor(() => provider?.release,
        'Deferred provider request did not begin');
    const countBeforeDestroy = notificationCount;
    service.destroy();
    assert(provider.cancellable.is_cancelled());
    assert(provider.disposed);
    provider.release([]);
    await startPromise;
    assertEqual(notificationCount, countBeforeDestroy);
    assertEqual(scheduler.active.size, 0);
});

print(`1..${passed}`);
