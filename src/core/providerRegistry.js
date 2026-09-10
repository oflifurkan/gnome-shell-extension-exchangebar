import {ProviderUnavailableError} from './errors.js';

function validateMetadata(metadata) {
    if (!metadata || typeof metadata.id !== 'string' || metadata.id.length === 0)
        throw new TypeError('Provider metadata must contain an id');
    if (typeof metadata.name !== 'string' || metadata.name.length === 0)
        throw new TypeError('Provider metadata must contain a name');
}

export class ProviderRegistry {
    constructor() {
        this._entries = new Map();
    }

    register(metadata, factory) {
        validateMetadata(metadata);
        if (typeof factory !== 'function')
            throw new TypeError('Provider factory must be a function');
        if (this._entries.has(metadata.id))
            throw new TypeError(`Provider "${metadata.id}" is already registered`);

        const frozenMetadata = Object.freeze({
            ...metadata,
            capabilities: Object.freeze({...metadata.capabilities}),
            authentication: Object.freeze({...metadata.authentication}),
        });
        this._entries.set(metadata.id, {metadata: frozenMetadata, factory});
    }

    create(id, context = {}) {
        const entry = this._entries.get(id);
        if (!entry)
            throw new ProviderUnavailableError(`Provider "${id}" is not available`);
        return entry.factory(context);
    }

    getMetadata(id) {
        return this._entries.get(id)?.metadata ?? null;
    }

    list(capability = null) {
        return [...this._entries.values()]
            .map(entry => entry.metadata)
            .filter(metadata => !capability || metadata.capabilities[capability]);
    }
}
