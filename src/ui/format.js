export function formatNumber(value, precision) {
    return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
    }).format(value);
}

export function formatPanelQuote(id, value, precision) {
    const prefix = {
        USDTRY: '$',
        EURTRY: '€',
        GOLD_GRAM_TRY: 'Au ',
    }[id] ?? '';
    return `${prefix}${formatNumber(value, precision)}`;
}

export function formatTry(value, precision) {
    return `₺${formatNumber(value, precision)}`;
}
