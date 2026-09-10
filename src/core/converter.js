import {
    InvalidAmountError,
    MissingQuoteError,
    UnsupportedAssetError,
} from './errors.js';

export const ConverterAsset = Object.freeze({
    TRY: 'TRY',
    USD: 'USD',
    EUR: 'EUR',
    GOLD_GRAM: 'GOLD_GRAM',
});

export const ConverterAssets = Object.freeze([
    ConverterAsset.TRY,
    ConverterAsset.USD,
    ConverterAsset.EUR,
    ConverterAsset.GOLD_GRAM,
]);

export const ConverterAssetInfo = Object.freeze({
    [ConverterAsset.TRY]: Object.freeze({
        id: ConverterAsset.TRY,
        label: 'TRY',
        quoteId: null,
        precision: 2,
    }),
    [ConverterAsset.USD]: Object.freeze({
        id: ConverterAsset.USD,
        label: 'USD',
        quoteId: 'USDTRY',
        precision: 2,
    }),
    [ConverterAsset.EUR]: Object.freeze({
        id: ConverterAsset.EUR,
        label: 'EUR',
        quoteId: 'EURTRY',
        precision: 2,
    }),
    [ConverterAsset.GOLD_GRAM]: Object.freeze({
        id: ConverterAsset.GOLD_GRAM,
        label: 'Gold (g)',
        quoteId: 'GOLD_GRAM_TRY',
        precision: 4,
    }),
});

function validateAsset(asset) {
    const info = ConverterAssetInfo[asset];
    if (!info)
        throw new UnsupportedAssetError(`Unsupported converter asset "${asset}"`);
    return info;
}

function validateAmount(amount) {
    if (!Number.isFinite(amount) || amount < 0)
        throw new InvalidAmountError('Amount must be a non-negative finite number');
}

function tryRate(asset, quotes) {
    const info = validateAsset(asset);
    if (info.quoteId === null)
        return 1;

    const quote = quotes?.[info.quoteId];
    if (!quote || !Number.isFinite(quote.value) || quote.value <= 0)
        throw new MissingQuoteError(`Quote "${info.quoteId}" is unavailable`);
    return quote.value;
}

export function parseAmount(text) {
    if (typeof text !== 'string')
        throw new InvalidAmountError('Amount must be text');

    const input = text.trim();
    if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(input))
        throw new InvalidAmountError('Enter a valid non-negative amount');

    const amount = Number(input.replace(',', '.'));
    validateAmount(amount);
    return amount;
}

export function convert(amount, fromAsset, toAsset, quotes) {
    validateAmount(amount);
    validateAsset(fromAsset);
    validateAsset(toAsset);
    if (fromAsset === toAsset)
        return amount;

    const sourceTryRate = tryRate(fromAsset, quotes);
    const targetTryRate = tryRate(toAsset, quotes);
    return amount * sourceTryRate / targetTryRate;
}

export function convertAll(amount, fromAsset, quotes) {
    validateAmount(amount);
    validateAsset(fromAsset);
    return ConverterAssets
        .filter(asset => asset !== fromAsset)
        .map(asset => ({
            asset,
            value: convert(amount, fromAsset, asset, quotes),
        }));
}
