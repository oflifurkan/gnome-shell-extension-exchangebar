import Gio from 'gi://Gio';

import {
    InvalidResponseError,
    ProviderUnavailableError,
    isCancellationError,
} from './errors.js';
import {createMarketSnapshot} from './quote.js';

const EXPECTED_QUOTES = Object.freeze({
    fx: ['USDTRY', 'EURTRY'],
    gold: ['GOLD_GRAM_TRY'],
});

export class MarketService {
    constructor({settings, registry, providerContext = {}}) {
        this._settings = settings;
        this._registry = registry;
        this._providerContext = providerContext;
        this._providers = new Map();
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._settingsSignalIds = [];
        this._snapshot = createMarketSnapshot([]);
        this._status = 'loading';
        this._lastError = null;
        this._refreshPromise = null;
        this._cancellable = null;
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
            await this.refresh();
        } catch (error) {
            if (!this._destroyed) {
                this._status = 'error';
                this._lastError = error;
                this._emitChanged();
            }
        }
    }

    refresh() {
        if (this._destroyed)
            return Promise.resolve();
        if (this._refreshPromise)
            return this._refreshPromise;

        const generation = this._generation;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._status = this._snapshot.updatedAt === null ? 'loading' : 'ready';
        this._lastError = null;
        this._emitChanged();

        const task = this._fetchAll(generation, cancellable);
        this._refreshPromise = task.finally(() => {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            if (this._refreshPromise)
                this._refreshPromise = null;
        });
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
        } catch (error) {
            if (this._destroyed || generation !== this._generation ||
                isCancellationError(error))
                return;
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
    }

    _handleProviderChange() {
        if (this._destroyed)
            return;
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
            }
        });
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
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;

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
    }
}
