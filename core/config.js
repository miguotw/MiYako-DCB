const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config/config.yml', 'utf8');
const configCommandsFile = fs.readFileSync('./config/configCommands.yml', 'utf8');

// 解析 YAML 文件
const config = yaml.parse(configFile);
const configCommands = yaml.parse(configCommandsFile);

// 導出設定
module.exports = { config, configCommands };