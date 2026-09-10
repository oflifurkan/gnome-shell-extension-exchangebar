export class Provider {
    constructor(metadata) {
        if (new.target === Provider)
            throw new TypeError('Provider is an abstract class');
        this.metadata = metadata;
    }

    async fetchQuotes(_request, _cancellable) {
        throw new Error('Provider.fetchQuotes() must be implemented');
    }

    dispose() {}
}
