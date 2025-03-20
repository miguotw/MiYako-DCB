const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const configUtilFile = fs.readFileSync('./confingUtil.yml', 'utf8');

// 解析 YAML 文件
const config = yaml.parse(configFile);
const configUtil = yaml.parse(configUtilFile);

// 導出設定
module.exports = { config, configUtil };