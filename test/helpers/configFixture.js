'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_DIRECTORY = path.join(PROJECT_ROOT, 'config_example');
const FILES = ['config.yml', 'configCommands.yml', 'configModules.yml'];
const TEST_GAME_CHECK_IN_ENCRYPTION_KEY = '11'.repeat(32);

function createValidConfigDocuments() {
    const documents = Object.fromEntries(FILES.map(fileName => {
        const source = fs.readFileSync(path.join(EXAMPLE_DIRECTORY, fileName), 'utf8');
        return [fileName, yaml.parse(source)];
    }));
    documents['configCommands.yml'].gameCheckIn.credentialEncryptionKey = TEST_GAME_CHECK_IN_ENCRYPTION_KEY;
    return documents;
}

function createConfigFixture({ documents = createValidConfigDocuments(), modes = {} } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-config-'));
    for (const fileName of FILES) {
        const filePath = path.join(directory, fileName);
        fs.writeFileSync(filePath, yaml.stringify(documents[fileName]), { mode: 0o600 });
        fs.chmodSync(filePath, modes[fileName] ?? 0o600);
    }
    return { directory, documents };
}

function removeConfigFixture(directory) {
    fs.rmSync(directory, { recursive: true, force: true });
}

module.exports = {
    FILES,
    PROJECT_ROOT,
    TEST_GAME_CHECK_IN_ENCRYPTION_KEY,
    createConfigFixture,
    createValidConfigDocuments,
    removeConfigFixture
};
