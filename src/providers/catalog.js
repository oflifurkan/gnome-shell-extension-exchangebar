import {ProviderRegistry} from '../core/providerRegistry.js';
import {
    DolarTodayProvider,
    DolarTodaySource,
} from './dolarToday.js';
import {FakeProvider} from './fakeProvider.js';
import {XausProvider} from './xaus.js';

const DEFINITIONS = Object.freeze([
    Object.freeze({
        metadata: DolarTodayProvider.metadata,
        factory: context => new DolarTodayProvider({
            ...context,
            source: context.settings?.get_string('dolar-today-source') ??
                DolarTodaySource.FREE_MARKET,
        }),
        preferences: Object.freeze([
            Object.freeze({
                key: 'dolar-today-source',
                type: 'choice',
                title: 'Rate source',
                choices: Object.freeze([
                    Object.freeze({
                        value: DolarTodaySource.FREE_MARKET,
                        label: 'Free Market',
                    }),
                    Object.freeze({
                        value: DolarTodaySource.TCMB,
                        label: 'TCMB',
                    }),
                ]),
            }),
        ]),
    }),
    Object.freeze({
        metadata: XausProvider.metadata,
        factory: context => new XausProvider(context),
        preferences: Object.freeze([]),
    }),
    Object.freeze({
        metadata: FakeProvider.metadata,
        factory: context => new FakeProvider(context),
        preferences: Object.freeze([]),
        test: true,
    }),
]);

export function createProviderRegistry() {
    const registry = new ProviderRegistry();
    for (const definition of DEFINITIONS)
        registry.register(definition.metadata, definition.factory);
    return registry;
}

export function listProviderChoices(capability) {
    return DEFINITIONS
        .filter(definition => definition.metadata.capabilities[capability])
        .map(definition => Object.freeze({
            value: definition.metadata.id,
            label: definition.test
                ? `${definition.metadata.name} (Test)`
                : definition.metadata.name,
        }));
}

export function getProviderPreferences(providerId) {
    return DEFINITIONS.find(
        definition => definition.metadata.id === providerId)?.preferences ?? [];
}
