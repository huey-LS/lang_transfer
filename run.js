'use strict';

const config_file = process.argv[3];
const config_list = process.argv[2];
const LangTransfer = require('./lang.js');

var config = require(config_list);

var files;

if(!config_file || config_file === 'all'){
    files = Object.keys(config).map((key) => config[key]);
} else {
    files = [config[config_file] || config_file];
}

files.forEach((file) => {
    let lang = new LangTransfer(file);
    lang.run();
});

