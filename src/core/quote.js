import {InvalidResponseError} from './errors.js';

export const QuoteKind = Object.freeze({
    CURRENCY: 'currency',
    COMMODITY: 'commodity',
});

function requireString(value, field) {
    if (typeof value !== 'string' || value.length === 0)
        throw new InvalidResponseError(`Quote field "${field}" must be a non-empty string`);
    return value;
}

function requireNumber(value, field) {
    if (!Number.isFinite(value) || value <= 0)
        throw new InvalidResponseError(`Quote field "${field}" must be a positive number`);
    return value;
}

function requireTimestamp(value) {
    if (!Number.isInteger(value) || value < 0)
        throw new InvalidResponseError('Quote timestamp must be a non-negative integer');
    return value;
}

function optionalPrice(value, field) {
    return value === null || value === undefined
        ? null
        : requireNumber(value, field);
}

function commonQuote(input, kind) {
    return {
        id: requireString(input.id, 'id'),
        kind,
        value: requireNumber(input.value, 'value'),
        timestamp: requireTimestamp(input.timestamp),
        provider: requireString(input.provider, 'provider'),
        stale: Boolean(input.stale),
        bid: optionalPrice(input.bid, 'bid'),
        ask: optionalPrice(input.ask, 'ask'),
    };
}

export function createCurrencyQuote(input) {
    return Object.freeze({
        ...commonQuote(input, QuoteKind.CURRENCY),
        base: requireString(input.base, 'base'),
        quote: requireString(input.quote, 'quote'),
    });
}

export function createCommodityQuote(input) {
    return Object.freeze({
        ...commonQuote(input, QuoteKind.COMMODITY),
        asset: requireString(input.asset, 'asset'),
        currency: requireString(input.currency, 'currency'),
        unit: requireString(input.unit, 'unit'),
    });
}

export function normalizeQuote(input) {
    if (input?.kind === QuoteKind.CURRENCY)
        return createCurrencyQuote(input);
    if (input?.kind === QuoteKind.COMMODITY)
        return createCommodityQuote(input);
    throw new InvalidResponseError('Quote kind is not supported');
}

export function createMarketSnapshot(quotes, {cached = false} = {}) {
    const quoteMap = {};
    for (const quote of quotes) {
        const normalized = normalizeQuote(quote);
        if (quoteMap[normalized.id])
            throw new InvalidResponseError(`Duplicate quote "${normalized.id}"`);
        quoteMap[normalized.id] = normalized;
    }

    const values = Object.values(quoteMap);
    return Object.freeze({
        quotes: Object.freeze(quoteMap),
        updatedAt: values.length > 0
            ? Math.min(...values.map(quote => quote.timestamp))
            : null,
        stale: values.some(quote => quote.stale),
        cached: Boolean(cached),
    });
}
