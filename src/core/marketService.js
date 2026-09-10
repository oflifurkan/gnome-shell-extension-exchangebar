import Gio from 'gi://Gio';

import {
    InvalidResponseError,
    ProviderUnavailableError,
    isCancellationError,
} from './errors.js';
import {createMarketSnapshot} from './quote.js';
import {GlibScheduler} from './scheduler.js';

const EXPECTED_QUOTES = Object.freeze({
    fx: ['USDTRY', 'EURTRY'],
    gold: ['GOLD_GRAM_TRY'],
});

const CACHED_QUOTES = Object.freeze({
    fx: ['USDTRY', 'EURTRY'],
    gold: ['GOLD_GRAM_TRY', 'XAUUSD'],
});

export const REFRESH_INTERVALS = Object.freeze([600, 900, 1800, 3600]);

export class MarketService {
    constructor({
        settings,
        registry,
        providerContext = {},
        scheduler = new GlibScheduler(),
        cache = null,
        clock = () => Math.floor(Date.now() / 1000),
    }) {
        this._settings = settings;
        this._registry = registry;
        this._providerContext = providerContext;
        this._scheduler = scheduler;
        this._cache = cache;
        this._clock = clock;
        this._providers = new Map();
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._settingsSignalIds = [];
        this._snapshot = createMarketSnapshot([]);
        this._status = 'loading';
        this._lastError = null;
        this._refreshPromise = null;
        this._isRefreshing = false;
        this._cancellable = null;
        this._lifecycleCancellable = new Gio.Cancellable();
        this._timerId = 0;
        this._generation = 0;
        this._destroyed = false;
        this._started = false;
    }

    get status() {
        return this._status;
    }

    get lastError() {
        return this._lastError;
    }

    get isRefreshing() {
        return this._isRefreshing;
    }

    getSnapshot() {
        return this._snapshot;
    }

    getQuote(id) {
        return this._snapshot.quotes[id] ?? null;
    }

    getProviderName(id) {
        return this._registry.getMetadata(id)?.name ?? id;
    }

    subscribe(callback) {
        if (typeof callback !== 'function')
            throw new TypeError('MarketService listener must be a function');
        const id = this._nextListenerId++;
        this._listeners.set(id, callback);
        return id;
    }

    unsubscribe(id) {
        this._listeners.delete(id);
    }

    async start() {
        if (this._destroyed || this._started)
            return;
        this._started = true;
        this._connectSettings();
        try {
            this._configureProviders();
            const loadedCache = await this._loadCache();
            if (this._destroyed)
                return;
            if (loadedCache && !this._snapshotNeedsRefresh()) {
                this._scheduleNextRefresh(this._remainingRefreshDelay());
                return;
            }
            await this.refresh();
        } catch (error) {
            if (!this._destroyed) {
                this._status = 'error';
                this._lastError = error;
                this._emitChanged();
                this._scheduleNextRefresh();
            }
        }
    }

    refresh() {
        if (this._destroyed)
            return Promise.resolve();
        this._cancelRefreshTimer();
        if (this._refreshPromise)
            return this._refreshPromise;

        const generation = this._generation;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._isRefreshing = true;
        this._markAgedQuotesStale();
        this._status = this._snapshot.updatedAt === null ? 'loading' : 'ready';
        this._lastError = null;

        const task = this._fetchAll(generation, cancellable);
        const refreshPromise = task.finally(() => {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            if (this._refreshPromise === refreshPromise) {
                this._refreshPromise = null;
                this._isRefreshing = false;
                if (!this._destroyed) {
                    this._emitChanged();
                    this._scheduleNextRefresh();
                }
            }
        });
        this._refreshPromise = refreshPromise;
        this._emitChanged();
        return this._refreshPromise;
    }

    async _fetchAll(generation, cancellable) {
        try {
            const providerRequests = new Map();
            for (const role of ['fx', 'gold']) {
                const id = this._settings.get_string(`${role}-provider`);
                const entry = providerRequests.get(id) ?? {fx: false, gold: false};
                entry[role] = true;
                providerRequests.set(id, entry);
            }

            const requests = [...providerRequests];
            const batches = await Promise.all(requests.map(
                ([id, request]) => this._providers.get(id)
                    .fetchQuotes(request, cancellable)));

            if (this._destroyed || generation !== this._generation ||
                cancellable.is_cancelled())
                return;

            requests.forEach(([id, request], index) =>
                this._validateProviderBatch(id, request, batches[index]));
            const quotes = batches.flat();
            this._snapshot = createMarketSnapshot(quotes);
            this._status = 'ready';
            this._lastError = null;
            this._emitChanged();
            await this._saveCache(this._snapshot, cancellable);
        } catch (error) {
            if (this._destroyed || generation !== this._generation ||
                isCancellationError(error))
                return;
            this._markAgedQuotesStale();
            this._status = 'error';
            this._lastError = error;
            this._emitChanged();
        }
    }

    _validateProviderBatch(providerId, request, quotes) {
        if (!Array.isArray(quotes))
            throw new InvalidResponseError('Provider returned an invalid quote collection');
        const ids = new Set(quotes.map(quote => quote.id));
        if (quotes.some(quote => quote.provider !== providerId))
            throw new InvalidResponseError(
                `Provider "${providerId}" returned a quote with the wrong source`);
        for (const role of ['fx', 'gold']) {
            if (!request[role])
                continue;
            for (const id of EXPECTED_QUOTES[role]) {
                if (!ids.has(id))
                    throw new InvalidResponseError(`Provider omitted quote "${id}"`);
            }
        }
    }

    _configureProviders() {
        const selections = [
            {
                role: 'fx',
                id: this._settings.get_string('fx-provider'),
                capability: 'currencies',
            },
            {
                role: 'gold',
                id: this._settings.get_string('gold-provider'),
                capability: 'metals',
            },
        ];
        for (const selection of selections) {
            const metadata = this._registry.getMetadata(selection.id);
            if (!metadata)
                throw new ProviderUnavailableError(
                    `Provider "${selection.id}" is not available`);
            if (!metadata.capabilities[selection.capability]) {
                throw new ProviderUnavailableError(
                    `Provider "${selection.id}" cannot supply ${selection.role} quotes`);
            }
        }
        const requiredIds = new Set(selections.map(selection => selection.id));

        for (const [id, provider] of this._providers) {
            if (!requiredIds.has(id)) {
                provider.dispose();
                this._providers.delete(id);
            }
        }

        for (const id of requiredIds) {
            if (!this._providers.has(id))
                this._providers.set(id,
                    this._registry.create(id, this._providerContext));
        }
    }

    _connectSettings() {
        for (const key of ['fx-provider', 'gold-provider']) {
            const id = this._settings.connect(`changed::${key}`,
                () => this._handleProviderChange());
            this._settingsSignalIds.push(id);
        }
        this._settingsSignalIds.push(this._settings.connect(
            'changed::refresh-interval',
            () => this._handleRefreshIntervalChange()));
    }

    _handleProviderChange() {
        if (this._destroyed)
            return;
        this._cancelRefreshTimer();
        this._generation++;
        this._cancellable?.cancel();
        const pending = this._refreshPromise ?? Promise.resolve();
        void pending.catch(() => {}).finally(() => {
            if (this._destroyed)
                return;
            try {
                this._configureProviders();
                void this.refresh();
            } catch (error) {
                this._status = 'error';
                this._lastError = error;
                this._emitChanged();
                this._scheduleNextRefresh();
            }
        });
    }

    _handleRefreshIntervalChange() {
        if (this._destroyed)
            return;
        this._cancelRefreshTimer();
        if (!this._isRefreshing)
            this._scheduleNextRefresh();
    }

    _getRefreshInterval() {
        const interval = this._settings.get_uint('refresh-interval');
        return REFRESH_INTERVALS.includes(interval) ? interval : 600;
    }

    async _loadCache() {
        if (!this._cache)
            return false;

        try {
            const snapshot = await this._cache.load(this._lifecycleCancellable);
            if (this._destroyed || !snapshot)
                return false;
            const cached = this._prepareCachedSnapshot(snapshot);
            if (cached.updatedAt === null)
                return false;
            this._snapshot = cached;
            this._status = 'ready';
            this._lastError = null;
            this._emitChanged();
            return true;
        } catch (error) {
            if (!this._destroyed && !isCancellationError(error))
                console.warn('ExchangeBar could not load its market cache', error);
            return false;
        }
    }

    _prepareCachedSnapshot(snapshot) {
        const now = this._clock();
        const interval = this._getRefreshInterval();
        const quotes = [];
        for (const role of ['fx', 'gold']) {
            const providerId = this._settings.get_string(`${role}-provider`);
            for (const id of CACHED_QUOTES[role]) {
                const quote = snapshot.quotes[id];
                if (!quote || quote.provider !== providerId)
                    continue;
                const age = Math.max(0, now - quote.timestamp);
                quotes.push({
                    ...quote,
                    stale: quote.stale || age >= interval,
                });
            }
        }
        return createMarketSnapshot(quotes, {cached: true});
    }

    _snapshotNeedsRefresh() {
        if (this._snapshot.stale)
            return true;
        for (const role of ['fx', 'gold']) {
            const providerId = this._settings.get_string(`${role}-provider`);
            for (const id of EXPECTED_QUOTES[role]) {
                if (this._snapshot.quotes[id]?.provider !== providerId)
                    return true;
            }
        }
        return false;
    }

    _markAgedQuotesStale() {
        if (!this._snapshot.cached)
            return;
        const now = this._clock();
        const interval = this._getRefreshInterval();
        const currentQuotes = Object.values(this._snapshot.quotes);
        const quotes = currentQuotes.map(quote => ({
            ...quote,
            stale: quote.stale || Math.max(0, now - quote.timestamp) >= interval,
        }));
        if (quotes.some((quote, index) =>
            quote.stale !== currentQuotes[index].stale)) {
            this._snapshot = createMarketSnapshot(quotes, {
                cached: this._snapshot.cached,
            });
        }
    }

    _remainingRefreshDelay() {
        if (this._snapshot.updatedAt === null)
            return this._getRefreshInterval();
        const age = Math.max(0, this._clock() - this._snapshot.updatedAt);
        return Math.max(1, this._getRefreshInterval() - age);
    }

    async _saveCache(snapshot, cancellable) {
        if (!this._cache)
            return;
        try {
            await this._cache.save(snapshot, cancellable);
        } catch (error) {
            if (!this._destroyed && !isCancellationError(error))
                console.warn('ExchangeBar could not save its market cache', error);
        }
    }

    _scheduleNextRefresh(delay = this._getRefreshInterval()) {
        if (this._destroyed || !this._started || this._isRefreshing ||
            this._timerId !== 0)
            return;

        this._timerId = this._scheduler.scheduleSeconds(
            Math.max(1, Math.ceil(delay)),
            () => {
                this._timerId = 0;
                void this.refresh();
            });
    }

    _cancelRefreshTimer() {
        if (this._timerId === 0)
            return;
        this._scheduler.cancel(this._timerId);
        this._timerId = 0;
    }

    _emitChanged() {
        if (this._destroyed)
            return;
        for (const callback of this._listeners.values()) {
            try {
                callback(this);
            } catch (error) {
                console.error('ExchangeBar listener failed', error);
            }
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._started = false;
        this._generation++;
        this._cancelRefreshTimer();
        this._cancellable?.cancel();
        this._cancellable = null;
        this._lifecycleCancellable.cancel();

        for (const id of this._settingsSignalIds)
            this._settings.disconnect(id);
        this._settingsSignalIds = [];

        for (const provider of this._providers.values())
            provider.dispose();
        this._providers.clear();
        this._listeners.clear();
        this._settings = null;
        this._registry = null;
        this._providerContext = null;
        this._scheduler = null;
        this._cache = null;
        this._clock = null;
        this._lifecycleCancellable = null;
    }
}
