import Gio from 'gi://Gio';

export class ExchangeBarError extends Error {
    constructor(message, options = {}) {
        super(message, options);
        this.name = this.constructor.name;
    }
}

export class AuthenticationError extends ExchangeBarError {}
export class NetworkError extends ExchangeBarError {}
export class RateLimitError extends ExchangeBarError {}
export class InvalidResponseError extends ExchangeBarError {}
export class ProviderUnavailableError extends ExchangeBarError {}

export class CancellationError extends ExchangeBarError {}

export function isCancellationError(error) {
    return error instanceof CancellationError ||
        error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) === true;
}
