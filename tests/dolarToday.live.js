import Gio from 'gi://Gio';

import {DolarTodayProvider} from '../src/providers/dolarToday.js';

const provider = new DolarTodayProvider();
try {
    const quotes = await provider.fetchQuotes(
        {fx: true}, new Gio.Cancellable());
    for (const quote of quotes) {
        print(`${quote.id}: ${quote.value} ` +
            `(buy ${quote.bid}, sell ${quote.ask}, ${quote.provider})`);
    }
} finally {
    provider.dispose();
}
