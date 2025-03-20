const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const configCommandsFile = fs.readFileSync('./configCommands.yml', 'utf8');
const configModulesFile = fs.readFileSync('./configModules.yml', 'utf8');

// 解析 YAML 文件
const config = yaml.parse(configFile);
const configCommands = yaml.parse(configCommandsFile);
const configModules = yaml.parse(configModulesFile);

// 導出設定
module.exports = { config, configCommands, configModules };