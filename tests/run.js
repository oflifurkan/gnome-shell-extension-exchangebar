import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    CACHE_VERSION,
    MarketCache,
    deserializeMarketCache,
    serializeMarketCache,
} from '../src/core/cache.js';
import {
    ConverterAsset,
    convert,
    convertAll,
    parseAmount,
} from '../src/core/converter.js';
import {
    PANEL_POSITION_CHOICES,
    REFRESH_INTERVAL_CHOICES,
    findChoiceIndex,
    getChoiceValue,
} from '../prefs/choices.js';
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
import {
    DOLAR_TODAY_ENDPOINT,
    MAX_FX_FRESH_AGE_SECONDS,
    MAX_TCMB_FRESH_AGE_SECONDS,
    DolarTodayProvider,
    DolarTodaySource,
    buildDolarTodayEndpoint,
    parseDolarTodayRates,
    translateDolarTodayHttpError,
} from '../src/providers/dolarToday.js';
import {
    createProviderRegistry,
    getProviderPreferences,
    listProviderChoices,
} from '../src/providers/catalog.js';
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
import {PanelPosition, getPanelPlacement} from '../src/ui/panelPlacement.js';

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
            'dolar-today-source': 'serbest',
            'provider-mode': 'a',
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

function loadTextFixture(path) {
    const filename = GLib.build_filenamev([
        GLib.get_current_dir(), 'tests', 'fixtures', ...path.split('/'),
    ]);
    const [success, contents] = GLib.file_get_contents(filename);
    if (!success)
        throw new Error(`Unable to read fixture ${filename}`);
    return new TextDecoder().decode(contents);
}

function loadJsonFixture(path) {
    return JSON.parse(loadTextFixture(path));
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

class MemoryCache {
    constructor(snapshot = null, {loadError = null, saveError = null} = {}) {
        this.snapshot = snapshot;
        this.loadError = loadError;
        this.saveError = saveError;
        this.loadCalls = [];
        this.saveCalls = [];
    }

    async load(cancellable) {
        this.loadCalls.push(cancellable);
        if (this.loadError)
            throw this.loadError;
        return this.snapshot;
    }

    async save(snapshot, cancellable) {
        this.saveCalls.push({snapshot, cancellable});
        if (this.saveError)
            throw this.saveError;
        this.snapshot = snapshot;
    }
}

class DeferredCache extends MemoryCache {
    load(cancellable) {
        this.loadCalls.push(cancellable);
        return new Promise(resolve => {
            this.release = resolve;
        });
    }
}

function marketSnapshot({
    fxProvider = 'fake',
    goldProvider = fxProvider,
    timestamp = 1000,
    stale = false,
} = {}) {
    return createMarketSnapshot([
        createCurrencyQuote({
            id: 'USDTRY', base: 'USD', quote: 'TRY', value: 48.47,
            timestamp, provider: fxProvider, stale,
        }),
        createCurrencyQuote({
            id: 'EURTRY', base: 'EUR', quote: 'TRY', value: 56.37,
            timestamp, provider: fxProvider, stale,
        }),
        createCommodityQuote({
            id: 'GOLD_GRAM_TRY', asset: 'GOLD', currency: 'TRY', unit: 'GRAM',
            value: 5421, timestamp, provider: goldProvider, stale,
        }),
    ], {cached: true});
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

await test('market cache serialization is versioned and validates quotes', () => {
    const snapshot = marketSnapshot();
    const serialized = serializeMarketCache(snapshot, 1200);
    const payload = JSON.parse(serialized);
    assertEqual(payload.version, CACHE_VERSION);
    assertEqual(payload.savedAt, 1200);
    assertEqual(payload.quotes.USDTRY.value, 48.47);

    const restored = deserializeMarketCache(serialized);
    assert(restored.cached);
    assertEqual(restored.quotes.GOLD_GRAM_TRY.unit, 'GRAM');
    assertEqual(deserializeMarketCache('{broken'), null);
    assertEqual(deserializeMarketCache(JSON.stringify({
        version: CACHE_VERSION + 1,
        savedAt: 1200,
        quotes: payload.quotes,
    })), null);
    assertEqual(deserializeMarketCache(JSON.stringify({
        version: CACHE_VERSION,
        savedAt: 'invalid',
        quotes: payload.quotes,
    })), null);
    payload.quotes.USDTRY.id = 'WRONG';
    assertEqual(deserializeMarketCache(JSON.stringify(payload)), null);
    assertThrows(() => serializeMarketCache(snapshot, -1), TypeError);
});

await test('market cache performs an asynchronous Gio disk round trip', async () => {
    const directoryPath = GLib.dir_make_tmp('exchangebar-cache-test-XXXXXX');
    const path = GLib.build_filenamev([directoryPath, 'market.json']);
    const file = Gio.File.new_for_path(path);
    const directory = Gio.File.new_for_path(directoryPath);
    try {
        const cache = new MarketCache({path, clock: () => 1200});
        assertEqual(await cache.load(), null);
        await cache.save(marketSnapshot());
        const restored = await cache.load();
        assert(restored.cached);
        assertEqual(restored.quotes.USDTRY.value, 48.47);
    } finally {
        try {
            file.delete(null);
        } catch (_error) {
            // The file is absent when setup failed before the write.
        }
        directory.delete(null);
    }
});

await test('registry creates providers and filters capabilities', () => {
    const registry = createRegistry();
    assertEqual(registry.create('fake').metadata.name, 'Fake Provider');
    assertEqual(registry.list('metals').length, 1);
    assertThrows(() => registry.create('missing'), ProviderUnavailableError);
    assertThrows(() => registry.register(FakeProvider.metadata, () => null), TypeError);
});

await test('provider catalog exposes ordered capability choices and settings', () => {
    const registry = createProviderRegistry();
    assertEqual(registry.list('currencies')[0].id, 'dolar-today');
    assertEqual(registry.list('metals')[0].id, 'xaus');
    assert(Object.isFrozen(
        registry.getMetadata('dolar-today').settingsKeys));
    assertEqual(
        registry.getMetadata('dolar-today').settingsKeys[0],
        'dolar-today-source');

    const fxChoices = listProviderChoices('currencies');
    assertEqual(fxChoices[0].value, 'dolar-today');
    assertEqual(fxChoices.at(-1).value, 'fake');
    assertEqual(fxChoices.at(-1).label, 'Fake Provider (Test)');
    const goldChoices = listProviderChoices('metals');
    assertEqual(goldChoices[0].value, 'xaus');
    assertEqual(goldChoices.at(-1).value, 'fake');

    const preferences = getProviderPreferences('dolar-today');
    assertEqual(preferences.length, 1);
    assertEqual(preferences[0].key, 'dolar-today-source');
    assertEqual(getProviderPreferences('xaus').length, 0);
});

await test('preference choice mapping preserves stable stored values', () => {
    assertEqual(findChoiceIndex(REFRESH_INTERVAL_CHOICES, 1800), 2);
    assertEqual(findChoiceIndex(REFRESH_INTERVAL_CHOICES, 601), -1);
    assertEqual(getChoiceValue(REFRESH_INTERVAL_CHOICES, 0), 600);
    assertEqual(getChoiceValue(REFRESH_INTERVAL_CHOICES, 3), 3600);
    assertThrows(() => getChoiceValue(REFRESH_INTERVAL_CHOICES, -1), RangeError);
    assertThrows(() => getChoiceValue(REFRESH_INTERVAL_CHOICES, 4), RangeError);
    assertEqual(findChoiceIndex(PANEL_POSITION_CHOICES, 'center'), 1);
    assertEqual(getChoiceValue(PANEL_POSITION_CHOICES, 0), 'right');
});

await test('panel placement maps settings to public panel boxes', () => {
    const right = getPanelPlacement(PanelPosition.RIGHT);
    assertEqual(right.box, 'right');
    assertEqual(right.position, 0);

    const center = getPanelPlacement(PanelPosition.CENTER);
    assertEqual(center.box, 'center');
    assertEqual(center.position, -1);

    assert(getPanelPlacement('unsupported') === right,
        'Unknown values should use the safe right-side fallback');
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

await test('active provider configuration changes recreate and refresh once', async () => {
    const tracker = [];
    const created = [];
    const registry = new ProviderRegistry();
    registry.register({
        ...testMetadata('configured'),
        settingsKeys: ['provider-mode'],
    }, context => {
        const provider = new TestProvider('configured', tracker);
        created.push({
            provider,
            mode: context.settings.get_string('provider-mode'),
        });
        return provider;
    });
    const settings = new FakeSettings({
        'fx-provider': 'configured',
        'gold-provider': 'configured',
    });
    const service = new MarketService({
        settings,
        registry,
        providerContext: {settings},
    });
    await service.start();
    assertEqual(created.length, 1);
    assertEqual(created[0].mode, 'a');

    settings.set_string('provider-mode', 'b');
    settings.set_string('provider-mode', 'c');
    await waitFor(() => created.length === 2 && tracker.length === 2,
        'Configured provider was not recreated and refreshed');
    assert(created[0].provider.disposed);
    assertEqual(created[1].mode, 'c');
    assertEqual(service.status, 'ready');
    service.destroy();
});

await test('fresh cache is shown without an immediate provider request', async () => {
    const tracker = [];
    let now = 1000;
    const scheduler = new FakeScheduler();
    const registry = new ProviderRegistry();
    registry.register(testMetadata('cached'),
        () => new TestProvider('cached', tracker, {fail: true}));
    const cache = new MemoryCache(marketSnapshot({
        fxProvider: 'cached',
        timestamp: 800,
    }));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'cached',
            'gold-provider': 'cached',
        }),
        registry,
        scheduler,
        cache,
        clock: () => now,
    });
    await service.start();
    assertEqual(tracker.length, 0);
    assertEqual(service.status, 'ready');
    assert(service.getSnapshot().cached);
    assert(!service.getSnapshot().stale);
    assertEqual(scheduler.scheduled[0].delay, 400);

    now = 1400;
    scheduler.fire(scheduler.scheduled[0].id);
    await waitFor(() => service.status === 'error',
        'Due cache refresh did not fail');
    assert(service.getSnapshot().stale);
    assertEqual(service.getQuote('USDTRY').value, 48.47);
    service.destroy();
});

await test('stale cache remains visible when its refresh fails', async () => {
    const tracker = [];
    const scheduler = new FakeScheduler();
    const registry = new ProviderRegistry();
    registry.register(testMetadata('offline'),
        () => new TestProvider('offline', tracker, {fail: true}));
    const cache = new MemoryCache(marketSnapshot({
        fxProvider: 'offline',
        timestamp: 400,
    }));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'offline',
            'gold-provider': 'offline',
        }),
        registry,
        scheduler,
        cache,
        clock: () => 1000,
    });
    await service.start();
    assertEqual(tracker.length, 1);
    assertEqual(service.status, 'error');
    assert(service.getSnapshot().cached);
    assert(service.getSnapshot().stale);
    assertEqual(service.getQuote('USDTRY').value, 48.47);
    assertEqual(cache.saveCalls.length, 0);
    assertEqual(scheduler.active.size, 1);
    service.destroy();
});

await test('cache filters quotes that do not match selected providers', async () => {
    const registry = new ProviderRegistry();
    registry.register(testMetadata('selected-fx'),
        () => new TestProvider('selected-fx', []));
    registry.register(testMetadata('selected-gold'),
        () => new TestProvider('selected-gold', [], {fail: true}));
    const cache = new MemoryCache(marketSnapshot({
        fxProvider: 'selected-fx',
        goldProvider: 'old-gold',
        timestamp: 900,
    }));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'selected-fx',
            'gold-provider': 'selected-gold',
        }),
        registry,
        cache,
        clock: () => 1000,
    });
    await service.start();
    assertEqual(service.status, 'error');
    assertEqual(service.getQuote('USDTRY').provider, 'selected-fx');
    assertEqual(service.getQuote('GOLD_GRAM_TRY'), null);
    service.destroy();
});

await test('successful refresh replaces cache without caching failures', async () => {
    const cache = new MemoryCache();
    const service = new MarketService({
        settings: new FakeSettings(),
        registry: createRegistry(),
        cache,
    });
    await service.start();
    assertEqual(cache.saveCalls.length, 1);
    assertEqual(Object.keys(cache.snapshot.quotes).length, 3);
    assert(!cache.snapshot.cached);
    service.destroy();
});

await test('cache write failures do not invalidate live quotes', async () => {
    const cache = new MemoryCache(null, {
        saveError: new Error('Test cache write failure'),
    });
    const service = new MarketService({
        settings: new FakeSettings(),
        registry: createRegistry(),
        cache,
    });
    await service.start();
    assertEqual(service.status, 'ready');
    assertEqual(service.getQuote('USDTRY').value, 48.47);
    service.destroy();
});

await test('destroy cancels a pending cache load and ignores its result', async () => {
    const cache = new DeferredCache();
    const service = new MarketService({
        settings: new FakeSettings(),
        registry: createRegistry(),
        cache,
        clock: () => 1000,
    });
    const startPromise = service.start();
    await waitFor(() => cache.release, 'Cache load did not begin');
    service.destroy();
    assert(cache.loadCalls[0].is_cancelled());
    cache.release(marketSnapshot({timestamp: 900}));
    await startPromise;
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

const DOLAR_TODAY_FIXTURE_TIME = Math.floor(
    Date.parse('2026-09-10T20:50:02+03:00') / 1000);

await test('DolarToday parser normalizes selling prices and bid/ask', () => {
    const quotes = parseDolarTodayRates(
        loadJsonFixture('dolar-today/rates-fresh.json'),
        {clock: () => DOLAR_TODAY_FIXTURE_TIME});
    assertEqual(quotes.length, 2);

    const usd = quotes.find(quote => quote.id === 'USDTRY');
    assertEqual(usd.base, 'USD');
    assertEqual(usd.quote, 'TRY');
    assertEqual(usd.value, 48.562735);
    assertEqual(usd.bid, 48.417265);
    assertEqual(usd.ask, 48.562735);
    assertEqual(usd.provider, 'dolar-today');
    assertEqual(usd.stale, false);

    const eur = quotes.find(quote => quote.id === 'EURTRY');
    assertEqual(eur.value, 56.439611);
    assertEqual(eur.bid, 56.270545);
    assertEqual(eur.ask, 56.439611);
    assertEqual(eur.timestamp, Math.floor(
        Date.parse('2026-09-10T20:45:02+03:00') / 1000));
    assertClose(convert(
        1, ConverterAsset.EUR, ConverterAsset.TRY,
        createMarketSnapshot(quotes).quotes), 56.439611);
});

await test('DolarToday supports Free Market and TCMB source configuration', async () => {
    assertEqual(
        buildDolarTodayEndpoint(DolarTodaySource.FREE_MARKET),
        DOLAR_TODAY_ENDPOINT);
    assert(buildDolarTodayEndpoint(DolarTodaySource.TCMB).endsWith('source=tcmb'));
    assertThrows(() => buildDolarTodayEndpoint('unknown'), TypeError);

    const payload = clone(loadJsonFixture('dolar-today/rates-fresh.json'));
    for (const rate of Object.values(payload.rates))
        rate.source = 'tcmb';
    const httpClient = new StubHttpClient({
        status: 200,
        body: JSON.stringify(payload),
    });
    const provider = new DolarTodayProvider({
        httpClient,
        source: DolarTodaySource.TCMB,
        clock: () => DOLAR_TODAY_FIXTURE_TIME,
    });
    const quotes = await provider.fetchQuotes({fx: true});
    assertEqual(quotes.length, 2);
    assert(httpClient.calls[0].url.endsWith('source=tcmb'));
    assertEqual(quotes[0].provider, 'dolar-today');
    assert(!quotes[0].stale);
    provider.dispose();

    const sourceTimestamp = Math.floor(Date.parse(payload.updated_at) / 1000);
    const currentTcmb = parseDolarTodayRates(payload, {
        source: DolarTodaySource.TCMB,
        clock: () => sourceTimestamp + 24 * 60 * 60,
    });
    assert(currentTcmb.every(quote => !quote.stale));
    const staleTcmb = parseDolarTodayRates(payload, {
        source: DolarTodaySource.TCMB,
        clock: () => sourceTimestamp + MAX_TCMB_FRESH_AGE_SECONDS + 1,
    });
    assert(staleTcmb.every(quote => quote.stale));

    assertThrows(() => parseDolarTodayRates(payload, {
        source: 'unknown',
        clock: () => DOLAR_TODAY_FIXTURE_TIME,
    }), TypeError);
});

await test('DolarToday parser detects stale rates from source timestamps', () => {
    const stale = parseDolarTodayRates(
        loadJsonFixture('dolar-today/rates-stale.json'),
        {clock: () => DOLAR_TODAY_FIXTURE_TIME});
    assert(stale.every(quote => quote.stale));

    const boundaryPayload = loadJsonFixture('dolar-today/rates-fresh.json');
    const timestamp = Math.floor(Date.parse(
        boundaryPayload.updated_at) / 1000);
    const boundary = parseDolarTodayRates(boundaryPayload, {
        clock: () => timestamp + MAX_FX_FRESH_AGE_SECONDS,
    });
    assert(boundary.every(quote => !quote.stale));
    const expired = parseDolarTodayRates(boundaryPayload, {
        clock: () => timestamp + MAX_FX_FRESH_AGE_SECONDS + 1,
    });
    assert(expired.every(quote => quote.stale));
});

await test('DolarToday parser rejects unavailable and malformed rates', () => {
    assertThrows(() => parseDolarTodayRates(
        loadJsonFixture('dolar-today/unavailable.json')),
    ProviderUnavailableError);
    assertThrows(() => parseDolarTodayRates(
        loadJsonFixture('dolar-today/incomplete.json'),
    {clock: () => DOLAR_TODAY_FIXTURE_TIME}), InvalidResponseError);

    const valid = loadJsonFixture('dolar-today/rates-fresh.json');
    for (const mutate of [
        value => value.base = 'USD',
        value => value.rates.USD.code = 'EUR',
        value => value.rates.USD.type = 'metal',
        value => value.rates.USD.source = 'tcmb',
        value => value.rates.USD.buy = 0,
        value => value.rates.USD.sell = -1,
        value => value.rates.USD.updated_at = 'not-a-date',
    ]) {
        const payload = clone(valid);
        mutate(payload);
        assertThrows(() => parseDolarTodayRates(
            payload, {clock: () => DOLAR_TODAY_FIXTURE_TIME}),
        InvalidResponseError);
    }
    assertThrows(() => parseDolarTodayRates(valid, {clock: () => 0}), TypeError);
});

await test('DolarToday HTTP errors map to common provider errors', () => {
    assert(translateDolarTodayHttpError(400) instanceof InvalidResponseError);
    assert(translateDolarTodayHttpError(404) instanceof InvalidResponseError);
    assert(translateDolarTodayHttpError(422) instanceof InvalidResponseError);
    assert(translateDolarTodayHttpError(429) instanceof RateLimitError);
    assert(translateDolarTodayHttpError(503) instanceof ProviderUnavailableError);
    assert(translateDolarTodayHttpError(418) instanceof NetworkError);
});

await test('DolarToday provider performs one keyless cancellable request', async () => {
    const httpClient = new StubHttpClient({
        status: 200,
        body: JSON.stringify(
            loadJsonFixture('dolar-today/rates-fresh.json')),
    });
    const provider = new DolarTodayProvider({
        httpClient,
        clock: () => DOLAR_TODAY_FIXTURE_TIME,
    });
    assert(provider.metadata.capabilities.currencies);
    assert(provider.metadata.capabilities.bidAsk);
    assert(!provider.metadata.capabilities.metals);
    assert(!provider.metadata.authentication.apiKey);
    const cancellable = new Gio.Cancellable();
    const quotes = await provider.fetchQuotes({fx: true}, cancellable);
    assertEqual(quotes.length, 2);
    assertEqual(httpClient.calls.length, 1);
    assertEqual(httpClient.calls[0].url, DOLAR_TODAY_ENDPOINT);
    assert(httpClient.calls[0].cancellable === cancellable);
    assertEqual((await provider.fetchQuotes({})).length, 0);
    assertEqual(httpClient.calls.length, 1);
    await assertRejects(() => provider.fetchQuotes({gold: true}),
        ProviderUnavailableError);
    provider.dispose();
    provider.dispose();
    await assertRejects(() => provider.fetchQuotes({fx: true}),
        ProviderUnavailableError);
});

await test('DolarToday provider translates malformed and failed responses', async () => {
    const malformed = new DolarTodayProvider({
        httpClient: new StubHttpClient({
            status: 200,
            body: loadTextFixture('dolar-today/malformed.txt'),
        }),
    });
    await assertRejects(() => malformed.fetchQuotes({fx: true}),
        InvalidResponseError);
    malformed.dispose();

    const unavailable = new DolarTodayProvider({
        httpClient: new StubHttpClient({
            status: 503,
            body: JSON.stringify(
                loadJsonFixture('dolar-today/unavailable.json')),
        }),
    });
    const error = await assertRejects(
        () => unavailable.fetchQuotes({fx: true}),
        ProviderUnavailableError);
    assertEqual(error.message, 'Rates are temporarily unavailable');
    unavailable.dispose();
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

await test('market service replaces Fake cache with DolarToday and XAUS', async () => {
    const registry = new ProviderRegistry();
    registry.register(DolarTodayProvider.metadata,
        () => new DolarTodayProvider({
            httpClient: new StubHttpClient({
                status: 200,
                body: JSON.stringify(
                    loadJsonFixture('dolar-today/rates-fresh.json')),
            }),
            clock: () => DOLAR_TODAY_FIXTURE_TIME,
        }));
    registry.register(XausProvider.metadata, () => new XausProvider({
        httpClient: new StubHttpClient({
            status: 200,
            body: JSON.stringify(loadJsonFixture('xaus/spot-fresh.json')),
        }),
        clock: () => XAUS_FIXTURE_TIME,
    }));
    const cache = new MemoryCache(marketSnapshot({timestamp: 1000}));
    const service = new MarketService({
        settings: new FakeSettings({
            'fx-provider': 'dolar-today',
            'gold-provider': 'xaus',
        }),
        registry,
        cache,
        clock: () => DOLAR_TODAY_FIXTURE_TIME,
    });
    await service.start();
    assertEqual(service.status, 'ready');
    assertEqual(service.getQuote('USDTRY').provider, 'dolar-today');
    assertEqual(service.getQuote('EURTRY').value, 56.439611);
    assertEqual(service.getQuote('GOLD_GRAM_TRY').provider, 'xaus');
    assertEqual(service.getQuote('XAUUSD').provider, 'xaus');
    assertEqual(cache.saveCalls.length, 1);
    assert(!cache.snapshot.cached);
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
