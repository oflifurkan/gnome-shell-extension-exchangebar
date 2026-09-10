import Gio from 'gi://Gio';

import {XausProvider} from '../src/providers/xaus.js';

const provider = new XausProvider();
try {
    const quotes = await provider.fetchQuotes(
        {gold: true}, new Gio.Cancellable());
    for (const quote of quotes)
        print(`${quote.id}: ${quote.value} (${quote.provider})`);
} finally {
    provider.dispose();
}
