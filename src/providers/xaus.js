import {
    InvalidResponseError,
    NetworkError,
    ProviderUnavailableError,
    RateLimitError,
} from '../core/errors.js';
import {createCommodityQuote} from '../core/quote.js';
import {SoupHttpClient} from './httpClient.js';
import {Provider} from './provider.js';

export const XAUS_ENDPOINT =
    'https://xaus.com/api/v1/spot?currency=TRY&unit=gram';
export const MAX_FRESH_AGE_SECONDS = 300;

function requirePositiveNumber(value, field) {
    if (!Number.isFinite(value) || value <= 0)
        throw new InvalidResponseError(`XAUS returned an invalid ${field}`);
    return value;
}

function parseSourceTimestamp(payload) {
    const value = payload.data_state?.as_of ??
        payload.price_as_of ?? payload.updated_at;
    if (typeof value !== 'string')
        throw new InvalidResponseError('XAUS returned no source timestamp');

    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0)
        throw new InvalidResponseError('XAUS returned an invalid source timestamp');
    return Math.floor(milliseconds / 1000);
}

function responseMessage(payload, fallback) {
    return typeof payload?.error === 'string' && payload.error.length > 0
        ? payload.error.slice(0, 300)
        : fallback;
}

export function translateXausHttpError(status, payload = null) {
    const message = responseMessage(payload, `XAUS request failed (${status})`);
    if (status === 429)
        return new RateLimitError(message);
    if (status === 503 || status >= 500)
        return new ProviderUnavailableError(message);
    if (status === 400 || status === 405)
        return new InvalidResponseError(message);
    return new NetworkError(message);
}

export function parseXausSpot(
    payload,
    {clock = () => Math.floor(Date.now() / 1000)} = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new InvalidResponseError('XAUS returned an invalid response');

    const state = payload.data_state?.status;
    if (state === 'unavailable')
        throw new ProviderUnavailableError('XAUS gold price is unavailable');
    if (state !== undefined && state !== 'fresh' && state !== 'stale')
        throw new InvalidResponseError('XAUS returned an invalid data state');
    if (!payload.xau || typeof payload.xau !== 'object')
        throw new InvalidResponseError('XAUS response has no gold quote');
    if (payload.xau.currency !== 'TRY')
        throw new InvalidResponseError('XAUS response currency must be TRY');
    if (payload.xau.unit !== 'gram')
        throw new InvalidResponseError('XAUS response unit must be gram');

    const timestamp = parseSourceTimestamp(payload);
    const receivedAt = clock();
    if (!Number.isInteger(receivedAt) || receivedAt <= 0)
        throw new TypeError('XAUS parser clock must return UNIX seconds');

    const gramTry = requirePositiveNumber(payload.xau.price, 'gram-gold price');
    const xauUsd = requirePositiveNumber(payload.spot_usd_oz, 'XAU/USD price');
    const ageSeconds = Math.max(0, receivedAt - timestamp);
    const goldStale = state === 'stale' || payload.stale === true ||
        ageSeconds > MAX_FRESH_AGE_SECONDS;

    return [
        createCommodityQuote({
            id: 'GOLD_GRAM_TRY',
            asset: 'GOLD',
            currency: 'TRY',
            unit: 'GRAM',
            value: gramTry,
            timestamp,
            provider: XausProvider.metadata.id,
            stale: goldStale || payload.fx_stale === true,
        }),
        createCommodityQuote({
            id: 'XAUUSD',
            asset: 'GOLD',
            currency: 'USD',
            unit: 'TROY_OUNCE',
            value: xauUsd,
            timestamp,
            provider: XausProvider.metadata.id,
            stale: goldStale,
        }),
    ];
}

export class XausProvider extends Provider {
    static metadata = Object.freeze({
        id: 'xaus',
        name: 'XAUS',
        capabilities: Object.freeze({
            currencies: false,
            metals: true,
            bidAsk: false,
            historical: false,
        }),
        authentication: Object.freeze({apiKey: false}),
        defaultRefreshInterval: 600,
    });

    constructor({
        httpClient = null,
        clock = () => Math.floor(Date.now() / 1000),
    } = {}) {
        super(XausProvider.metadata);
        this._httpClient = httpClient ?? new SoupHttpClient();
        this._ownsHttpClient = httpClient === null;
        this._clock = clock;
        this._disposed = false;
    }

    async fetchQuotes({fx = false, gold = false} = {}, cancellable = null) {
        if (this._disposed)
            throw new ProviderUnavailableError('XAUS provider has been disposed');
        if (fx)
            throw new ProviderUnavailableError('XAUS does not provide FX quotes');
        if (!gold)
            return [];

        const response = await this._httpClient.get(XAUS_ENDPOINT, cancellable);
        let payload = null;
        try {
            payload = JSON.parse(response.body);
        } catch (error) {
            if (response.status >= 200 && response.status < 300) {
                throw new InvalidResponseError(
                    'XAUS returned malformed JSON', {cause: error});
            }
        }

        if (response.status < 200 || response.status >= 300)
            throw translateXausHttpError(response.status, payload);
        return parseXausSpot(payload, {clock: this._clock});
    }

    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        if (this._ownsHttpClient)
            this._httpClient.dispose();
        this._httpClient = null;
        this._clock = null;
    }
}
