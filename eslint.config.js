import js from '@eslint/js';

const gjsGlobals = {
    ARGV: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    console: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
};

export default [
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'schemas/gschemas.compiled',
        ],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'array-bracket-spacing': ['error', 'never'],
            'comma-dangle': ['error', 'always-multiline'],
            'eqeqeq': ['error', 'always'],
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
            'object-curly-spacing': ['error', 'never'],
            'quotes': ['error', 'single', {allowTemplateLiterals: true}],
            'semi': ['error', 'always'],
        },
    },
];
