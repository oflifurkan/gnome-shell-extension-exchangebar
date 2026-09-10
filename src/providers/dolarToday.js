import {
    InvalidResponseError,
    NetworkError,
    ProviderUnavailableError,
    RateLimitError,
} from '../core/errors.js';
import {createCurrencyQuote} from '../core/quote.js';
import {SoupHttpClient} from './httpClient.js';
import {Provider} from './provider.js';

export const DolarTodaySource = Object.freeze({
    FREE_MARKET: 'serbest',
    TCMB: 'tcmb',
});

const VALID_SOURCES = Object.freeze(Object.values(DolarTodaySource));

function requireSource(source) {
    if (!VALID_SOURCES.includes(source))
        throw new TypeError(`Unsupported DolarToday source "${source}"`);
    return source;
}

export function buildDolarTodayEndpoint(source) {
    return 'https://dolartoday.org/api/rates?symbols=USD%2CEUR&source=' +
        encodeURIComponent(requireSource(source));
}

export const DOLAR_TODAY_ENDPOINT = buildDolarTodayEndpoint(
    DolarTodaySource.FREE_MARKET);
export const MAX_FX_FRESH_AGE_SECONDS = 900;
export const MAX_TCMB_FRESH_AGE_SECONDS = 7 * 24 * 60 * 60;

const REQUIRED_RATES = Object.freeze([
    {code: 'USD', id: 'USDTRY'},
    {code: 'EUR', id: 'EURTRY'},
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requirePositiveNumber(value, field) {
    if (!Number.isFinite(value) || value <= 0)
        throw new InvalidResponseError(`DolarToday returned an invalid ${field}`);
    return value;
}

function parseTimestamp(value) {
    if (typeof value !== 'string')
        throw new InvalidResponseError('DolarToday returned no source timestamp');
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0)
        throw new InvalidResponseError('DolarToday returned an invalid source timestamp');
    return Math.floor(milliseconds / 1000);
}

function responseMessage(payload, fallback) {
    const message = payload?.message ?? payload?.error;
    return typeof message === 'string' && message.length > 0
        ? message.slice(0, 300)
        : fallback;
}

export function translateDolarTodayHttpError(status, payload = null) {
    const message = responseMessage(
        payload, `DolarToday request failed (${status})`);
    if (status === 429)
        return new RateLimitError(message);
    if (status >= 500)
        return new ProviderUnavailableError(message);
    if ([400, 404, 422].includes(status))
        return new InvalidResponseError(message);
    return new NetworkError(message);
}

export function parseDolarTodayRates(
    payload,
    {
        clock = () => Math.floor(Date.now() / 1000),
        source = DolarTodaySource.FREE_MARKET,
    } = {}) {
    requireSource(source);
    if (!isRecord(payload))
        throw new InvalidResponseError('DolarToday returned an invalid response');
    if (payload.success !== true) {
        throw new ProviderUnavailableError(responseMessage(
            payload, 'DolarToday rates are unavailable'));
    }
    if (payload.base !== 'TRY')
        throw new InvalidResponseError('DolarToday response base must be TRY');
    if (!isRecord(payload.rates))
        throw new InvalidResponseError('DolarToday response has no rates');

    const receivedAt = clock();
    if (!Number.isInteger(receivedAt) || receivedAt <= 0)
        throw new TypeError('DolarToday parser clock must return UNIX seconds');

    return REQUIRED_RATES.map(({code, id}) => {
        const rate = payload.rates[code];
        if (!isRecord(rate) || rate.code !== code || rate.type !== 'forex') {
            throw new InvalidResponseError(
                `DolarToday response has no valid ${code} rate`);
        }
        if (rate.source !== source) {
            throw new InvalidResponseError(
                `DolarToday ${code} rate is from the wrong source`);
        }

        const bid = requirePositiveNumber(rate.buy, `${code} buying rate`);
        const ask = requirePositiveNumber(rate.sell, `${code} selling rate`);
        const timestamp = parseTimestamp(rate.updated_at ?? payload.updated_at);
        const ageSeconds = Math.max(0, receivedAt - timestamp);
        const maxFreshAge = source === DolarTodaySource.TCMB
            ? MAX_TCMB_FRESH_AGE_SECONDS
            : MAX_FX_FRESH_AGE_SECONDS;

        return createCurrencyQuote({
            id,
            base: code,
            quote: 'TRY',
            value: ask,
            timestamp,
            provider: DolarTodayProvider.metadata.id,
            stale: ageSeconds > maxFreshAge,
            bid,
            ask,
        });
    });
}

export class DolarTodayProvider extends Provider {
    static metadata = Object.freeze({
        id: 'dolar-today',
        name: 'DolarToday',
        capabilities: Object.freeze({
            currencies: true,
            metals: false,
            bidAsk: true,
            historical: false,
        }),
        authentication: Object.freeze({apiKey: false}),
        settingsKeys: Object.freeze(['dolar-today-source']),
        defaultRefreshInterval: 600,
    });

    constructor({
        httpClient = null,
        clock = () => Math.floor(Date.now() / 1000),
        source = DolarTodaySource.FREE_MARKET,
    } = {}) {
        super(DolarTodayProvider.metadata);
        this._httpClient = httpClient ?? new SoupHttpClient();
        this._ownsHttpClient = httpClient === null;
        this._clock = clock;
        this._source = requireSource(source);
        this._disposed = false;
    }

    async fetchQuotes({fx = false, gold = false} = {}, cancellable = null) {
        if (this._disposed) {
            throw new ProviderUnavailableError(
                'DolarToday provider has been disposed');
        }
        if (gold)
            throw new ProviderUnavailableError('DolarToday does not provide gold quotes');
        if (!fx)
            return [];

        const response = await this._httpClient.get(
            buildDolarTodayEndpoint(this._source), cancellable);
        let payload = null;
        try {
            payload = JSON.parse(response.body);
        } catch (error) {
            if (response.status >= 200 && response.status < 300) {
                throw new InvalidResponseError(
                    'DolarToday returned malformed JSON', {cause: error});
            }
        }

        if (response.status < 200 || response.status >= 300)
            throw translateDolarTodayHttpError(response.status, payload);
        return parseDolarTodayRates(payload, {
            clock: this._clock,
            source: this._source,
        });
    }

    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        if (this._ownsHttpClient)
            this._httpClient.dispose();
        this._httpClient = null;
        this._clock = null;
        this._source = null;
    }
}
