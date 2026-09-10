import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createMarketSnapshot} from './quote.js';

export const CACHE_VERSION = 1;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function serializeMarketCache(snapshot, savedAt) {
    if (!Number.isInteger(savedAt) || savedAt < 0)
        throw new TypeError('Cache timestamp must be UNIX seconds');

    return JSON.stringify({
        version: CACHE_VERSION,
        savedAt,
        quotes: snapshot.quotes,
    });
}

export function deserializeMarketCache(contents) {
    try {
        const data = JSON.parse(contents);
        if (!isRecord(data) || data.version !== CACHE_VERSION ||
            !Number.isInteger(data.savedAt) || data.savedAt < 0 ||
            !isRecord(data.quotes))
            return null;

        const quotes = [];
        for (const [id, quote] of Object.entries(data.quotes)) {
            if (!isRecord(quote) || quote.id !== id)
                return null;
            quotes.push(quote);
        }
        return createMarketSnapshot(quotes, {cached: true});
    } catch (_error) {
        return null;
    }
}

function loadContents(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (source, result) => {
            try {
                const [success, contents] = source.load_contents_finish(result);
                if (!success)
                    throw new Error('Unable to read market cache');
                resolve(contents);
            } catch (error) {
                reject(error);
            }
        });
    });
}

function replaceContents(file, contents, cancellable) {
    const bytes = new TextEncoder().encode(contents);
    return new Promise((resolve, reject) => {
        file.replace_contents_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable,
            (source, result) => {
                try {
                    const [success] = source.replace_contents_finish(result);
                    if (!success)
                        throw new Error('Unable to write market cache');
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export class MarketCache {
    constructor({
        path = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'exchangebar', 'market.json',
        ]),
        clock = () => Math.floor(Date.now() / 1000),
    } = {}) {
        this._file = Gio.File.new_for_path(path);
        this._directory = this._file.get_parent();
        this._clock = clock;
    }

    async load(cancellable = null) {
        let contents;
        try {
            contents = await loadContents(this._file, cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw error;
        }
        return deserializeMarketCache(new TextDecoder().decode(contents));
    }

    async save(snapshot, cancellable = null) {
        try {
            this._directory.make_directory_with_parents(cancellable);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw error;
        }
        const contents = serializeMarketCache(snapshot, this._clock());
        await replaceContents(this._file, contents, cancellable);
    }
}
