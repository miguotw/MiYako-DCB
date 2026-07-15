'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'runtime/**',
            'config/**',
            'assets/**'
        ]
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: globals.node
        },
        rules: {
            // Logger 必須直接匹配控制字元；這是輸入清理而非可疑 regex。
            'no-control-regex': 'off',
            // 補償與 best-effort 清理允許明確空 catch，其他空區塊仍拒絕。
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }]
        }
    }
];
