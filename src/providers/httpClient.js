import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {CancellationError, NetworkError} from '../core/errors.js';

Gio._promisify(
    Soup.Session.prototype,
    'send_and_read_async',
    'send_and_read_finish');

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class SoupHttpClient {
    constructor({timeout = 30, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES} = {}) {
        this._session = new Soup.Session({
            timeout,
            user_agent: 'ExchangeBar/0.1.0',
        });
        this._maxResponseBytes = maxResponseBytes;
        this._disposed = false;
    }

    async get(url, cancellable = null) {
        if (this._disposed)
            throw new NetworkError('HTTP client has been disposed');

        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new NetworkError('Unable to create HTTP request');

        try {
            const bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);
            if (bytes.get_size() > this._maxResponseBytes)
                throw new NetworkError('HTTP response is too large');

            return {
                status: message.get_status(),
                body: new TextDecoder().decode(bytes.get_data()),
            };
        } catch (error) {
            if (error instanceof NetworkError)
                throw error;
            if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new CancellationError('HTTP request was cancelled', {cause: error});
            throw new NetworkError('Unable to reach the market-data provider', {
                cause: error,
            });
        }
    }

    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        this._session.abort();
        this._session = null;
    }
}
