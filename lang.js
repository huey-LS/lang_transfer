'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

class LangPlugin {
    constructor(){
        this.has_run = [];
        this.reg = {
            start: /lang\.start:\s*\[([\w\s_]+)\]/,
            end: /lang\.end:\s*\[([\w\s_]+)\]/
        };
    }

    run (line){
        if(!this._running){
            return this.start(line);
        } else {
            return this.end(line);
        }
    }

    start (line){
        var _plugins = this.constructor._plugins;
        var action = this.reg.start.exec(line);
        if(action && _plugins[action[1]]){
            this._running = _plugins[action[1]]({line: line, state: 'start'});
            this._running.next();
            return true;
        } else {
            return false;
        }
    }
    end (line){
        var _plugins = this.constructor._plugins;
        var action = this.reg.end.exec(line);
        if(action && _plugins[action[1]] && this._running instanceof _plugins[action[1]]){
            this._running.next({line: line, state: 'end'});
            this.has_run.push(this._running);
            this._running = null;
        } else {
            this._running.next({line: line, state: 'running'});
        }
        return true;
    }

    static add(name, fn){
        if(!this._plugins) this._plugins = [];
        this._plugins[name] = fn;
    }
}


LangPlugin.add('use without validate', function* (start){
    var lines = [];
    lines.push(start.line);
    while(1){
        let {line, state} = yield lines;
        lines.push(line);
        if(state === 'end'){
            break;
        }
    }
    // 插件跑完
    var txt = yield lines;
    // 修改输出内容
    txt += lines.join('\n') + '\n';
    var error_txt = yield txt;
    // 修改error.md
    return error_txt;
})


class LangTransfer {
    constructor(config_file){
        var config = require(config_file);
        this.plugin = new LangPlugin();

        var config_dir = path.dirname(config_file);
        config.main.file = path.join(config_dir, config.main.file);
        config.output.dir = path.join(config_dir, config.output.dir);
        config.report.dir = config.report.dir && path.join(config_dir, config.report.dir);
        config.langs.forEach((item) => {item.file = path.join(config_dir, item.file)});

        this.config = config;
    }
    run(){
        var config = this.config;
        var langs = config.langs;
        var _self = this;

        var load_langs = langs.map((lang) => this.loadLang(lang.file, new RegExp(lang.reg)));
        Promise.all(load_langs)
            .then(function(lang_array){
                return Object.assign.apply(Object, [{}, ...lang_array]);
            })
            .then(function(new_langs){
                var reg = new RegExp(config.main.reg);
                return _self.loadLangLine(config.main.file, function* (){
                    var result = {
                        success: {},
                        error: {not_found:{}, duplicate:{}, not_use:[]}
                    }
                    while(1){
                        let line = yield result;
                        if(line !== undefined){
                            let r = reg.exec(line);
                            if(r){
                                if(new_langs[r[1]]){
                                    result.success[r[1]] = new_langs[r[1]].replace(/([^\\]|^)(["'])/g, '$1\\$2');
                                } else {
                                    if(config.use_not_found){
                                        result.success[r[1]] = r[2];
                                    }
                                    result.error.not_found[r[1]] = r[2];
                                }

                                if(result.error.duplicate[r[1]]){
                                    result.error.duplicate[r[1]] ++;
                                } else {
                                    result.error.duplicate[r[1]] = 1;
                                }
                            } else {
                                if(line !== ''){
                                    result.error.not_use.push(line);
                                }
                            }
                        } else {
                            break;
                        }
                    }
                    return result;
                });
            })
            .then(function(new_langs){
                var reject, resolve;
                var p = new Promise((_resolve, _reject) => {
                    resolve = _resolve;
                    reject = _reject;
                });
                fs.access(config.output.dir, (err) => {
                    if(err){
                        fs.mkdir(config.output.dir, (err) => {
                            _self.outputFile(path.join(config.output.dir, config.output.file), new_langs.success);
                            resolve(new_langs);
                        });
                    } else {
                        _self.outputFile(path.join(config.output.dir, config.output.file), new_langs.success);
                        resolve(new_langs);
                    }
                });
                return p;
            })
            .then(function(new_langs){
                var dir = config.report.dir;
                var currentDate = new Date();
                var time = [
                    currentDate.getFullYear(),
                    currentDate.getMonth() + 1,
                    currentDate.getDate(),
                    currentDate.getHours(),
                    currentDate.getMinutes()
                ].join('');

                function checkReportDir(dir, version){
                    var reject, resolve;
                    var version = version || 0;
                    var currentDir = (new Function('var time = arguments[0];return `' + dir + '`;'))(time);
                    var p = new Promise((_resolve, _reject) => {
                        resolve = _resolve;
                        reject = _reject;
                    });
                    if(config.report.disable_version){
                        resolve(currentDir);
                    } else {
                        if(version) currentDir += '(' + version + ')';
                        fs.access(currentDir, (err) => {
                            if(err){
                                resolve(currentDir);
                            } else {
                                version ++;
                                checkReportDir(dir, version).then((currentDir) => {resolve(currentDir)});
                            }
                        })
                    }

                    return p;
                }

                if(dir && config.report.file){
                    checkReportDir(dir).then((currentDir) => {
                        fs.mkdir(currentDir, (err) => {
                            _self.outputError(path.join(currentDir, config.report.file), new_langs.error, {warn: config.report.warn && config.report.warn.split(',')});
                        });
                    })
                } else if(config.report.warn){
                    _self.outputError(null, new_langs.error, {
                        warn: config.report.warn && config.report.warn.split(','),
                        name: path.join(config.output.dir, config.output.file)
                    });
                }
            })
            .catch((err) => {console.error(err);})
    }

    loadLangLine (file, fn){
        var resolve, reject;
        var p = new Promise(function(_resolve, _reject){
            resolve = _resolve;
            reject = _reject;
        });

        var result = {};
        fs.access(file, (err) => {
            if(err) {
                resolve(result);
            } else {
                const rl = readline.createInterface({
                    input: fs.createReadStream(file),
                });

                var online = fn();
                online.next();

                rl.on('line', (line) => {
                    online.next(line);
                })

                rl.on('close', () => {
                    resolve(online.next().value);
                })
            }
        })

        return p;
    }

    /**
     * 加载翻译好的内容
     * @param  {path} file 文件地址
     * @param  {reg} reg  每行的匹配正则
     * @return {promise}      resolve: json
     */
    loadLang (file, reg){
        var plugin = this.plugin;
        return this.loadLangLine(file, function* (){
            var result = {};
            while(1){
                let line = yield result;
                if(line !== undefined){
                    if(!plugin.run(line)){
                        let r = reg.exec(line);
                        if(r){
                            result[r[1]] = r[2];
                        }
                    }
                } else {
                    break;
                }
            }
            return result;
        });
    }

    outputFile (file, data){
        var plugin = this.plugin;
        var config = this.config;
        var txt = '';
        for(let key in data){
            let value = data[key];
            txt += (new Function('var key = arguments[0];var value = arguments[1];return `' + config.output.template + '`'))(key, value);
        }

        txt = plugin.has_run.reduce((txt, p) => {return p.next(txt).value || txt}, txt);

        if(config.output.content){
            txt = (new Function('var txt = arguments[0];return `' + config.output.content + '`'))(txt);
        }

        fs.writeFile(file, txt, ((err) => {
            if(err) throw err;
            console.log(`created ${file}`);
        }));
    }

    outputErrorFormat (data, options){
        var plugin = this.plugin;
        var config = this.config;
        var error_txt = {};
        var errors = {}

        var not_found = '';
        for(let key in data.not_found){
            let value = data.not_found[key];
            not_found += (new Function('var key = arguments[0];var value = arguments[1];return `' + config.output.template + '`'))(key, value);
        }
        errors.not_found = not_found;
        error_txt.not_found = `#NOT_FOUND:\n${not_found}\n`;

        var duplicate = '';
        for(let key in data.duplicate){
            let value = data.duplicate[key];
            if(value > 1){
                duplicate += `'${key}': ${value}\n`;
            }
        }
        errors.duplicate = duplicate;
        error_txt.duplicate = `#DUPLICATE:\n${duplicate}\n`;

        var not_use = '';
        data.not_use.forEach((item) => {
            not_use += `${item}\n`;
        });
        errors.not_use = not_use;
        error_txt.not_use = `#NOT_USE:\n${not_use}\n`;

        var txt = Object.keys(error_txt).map((key) => error_txt[key]);

        txt = plugin.has_run.reduce((txt, p) => {return p.next(txt).value || txt}, txt);

        return {
            errors: errors,
            error_messages: error_txt,
            message: txt
        }
    }

    outputWarn (errors, options){
        var warn = options.warn;
        if(warn.length){
            var warn_errors = warn.map((key) => {return errors.errors[key] ? errors.error_messages[key] : ''}).join('');
            if(warn_errors){
                console.warn('\x1B[31m warn:\x1B[0m', options.name || '', '\n', warn_errors);
            }
        }
    }

    outputError (file, data, options){
        options = Object.assign({}, options);
        options.warn = options.warn || [];

        var errors = this.outputErrorFormat(data, options);
        var outputWarn = this.outputWarn;

        if(file){
            fs.writeFile(file, errors.message, ((err) => {
                if(err) throw err;
                console.log(`created ${file}`);
                outputWarn(errors, {name: file, warn: options.warn});
            }));
        } else {
            outputWarn(errors, options);
        }
    }
}

LangTransfer.plugin = LangPlugin;

module.exports = LangTransfer;