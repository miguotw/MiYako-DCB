'use strict';

// node --test 會為每個測試檔建立隔離程序；preload 在 production module 被 require
// 以前先提供不含真實 secret 的 0600 fixture，避免測試意外讀取部署設定。
if (!process.env.MIYAKO_CONFIG_DIR) {
    const { createConfigFixture, removeConfigFixture } = require('./helpers/configFixture');
    const fixture = createConfigFixture();
    process.env.MIYAKO_CONFIG_DIR = fixture.directory;
    process.once('exit', () => removeConfigFixture(fixture.directory));
}
