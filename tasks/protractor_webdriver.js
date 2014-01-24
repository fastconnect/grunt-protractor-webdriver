/**
 * `grunt-protractor-webdriver`
 *
 * Grunt task to start the `Selenium Webdriver` which comes bundled with
 * `Protractor`, the E2E test framework for Angular applications.
 *
 * Copyright (c) 2014 Steffen Eckardt
 * Licensed under the MIT license.
 *
 * @see https://github.com/seckardt/grunt-protractor-webdriver
 * @see https://github.com/angular/protractor
 * @see https://code.google.com/p/selenium/wiki/WebDriverJs
 * @see http://angularjs.org
 */
module.exports = function (grunt) {
	'use strict';

	var spawn = require('child_process').spawn,
		http = require('http'),
		rl = require('readline'),
		noop = function () {},
		REGEXP_REMOTE = /RemoteWebDriver instances should connect to: (.*)/,
		REGEXP_STARTED = /Started org\.openqa\.jetty\.jetty\.Server/,
		REGEXP_RUNNING = /Selenium is already running/,
		REGEXP_FAILURE = /Failed to start/,
		REGEXP_SESSION_DELETE = /Executing: \[delete session: (.*)\]/,
		REGEXP_SESSION_NEW = /Executing: \[new session: (.*)\]/,
		REGEXP_CAPABILITIES = /Capabilities \[\{(.*)\}\]/,
		REGEXP_EXCEPTION = /Exception thrown(.*)/m,
		REGEXP_FATAL = /Fatal error/,
		REGEXP_SHUTDOWN_OK = /OKOK/i,
		DEFAULT_CMD = 'webdriver-manager start',
		DEFAULT_INSTANCE = 'http://localhost:4444';

	function exec(command) {
		var opts = {
			cwd: process.cwd(),
			stdio: [process.stdin]
		};

		if (process.platform === 'win32') {
			opts.windowsVerbatimArguments = true;

			var child = spawn('cmd.exe', ['/s', '/c', command.replace(/\//g, '\\')], opts);
			rl.createInterface({
				input: process.stdin,
				output: process.stdout
			}).on('SIGINT', function () {
				process.emit('SIGINT');
			});
			return child;
		} else {
			return spawn('/bin/sh', ['-c', command], opts);
		}
	}

	function extract(regexp, value, idx) {
		var result;
		if (regexp.test(value) && (result = regexp.exec(value)) && typeof result[idx] === 'string') {
			return result[idx].trim();
		}
		return '';
	}

	function Webdriver(context, options, restarted) {
		var done = context.async(),
			restartedPrefix = (restarted === true ? 'Res' : 'S'),
			selenium,
			destroy,
			failureTimeout,
			stackTrace,
			server = DEFAULT_INSTANCE,
			sessions = 0, // Running sessions
			status = [false, false, false],// [0 = Stopping, 1 = Stopped, 2 = exited]
			stopCallbacks = [];

		function start() {
			grunt.log.writeln((restartedPrefix + 'tarting').cyan + ' Selenium server');

			selenium = exec(options.path + options.command);
			selenium.on('error', exit)
				.on('uncaughtException', exit)
				.on('exit', exit)
				.on('close', exit)
				.on('SIGINT', exit);

			selenium.stdout.setEncoding('utf8');
			selenium.stderr.setEncoding('utf8');
			selenium.stdout.on('data', data);
			selenium.stderr.on('data', data);

			destroy = exit(selenium);
		}

		function started(callback) {
			status[1] = false;
			grunt.log.writeln((restartedPrefix + 'tarted').cyan + ' Selenium server: ' + server.green);
			if (callback) {
				callback();
			}
		}

		function stop(callback) {
			if (status[2]) {
				callback(true);
			} else if (status[0] || status[1]) {
				stopCallbacks.push(callback);
				return;
			}
			status[0] = true;
			grunt.log.writeln('Shutting down'.cyan + ' Selenium server: ' + server);

			var response = '';
			http.get(server + '/selenium-server/driver/?cmd=shutDownSeleniumServer', function (res) {
				res.on('data',function (data) {
					response += data;
				}).on('end', function () {
					status[0] = false;
					if (callback) {
						var success = status[1] = REGEXP_SHUTDOWN_OK.test(response),
							callbacks = stopCallbacks.slice();
						stopCallbacks = [];
						callbacks.push(callback);
						grunt.log.writeln('Shut down'.cyan + ' Selenium server: ' + server + ' (' + (success ? response.green : response.red) + ')');
						callbacks.forEach(function (cb) {
							cb(success);
						});
					}
				});
			});
		}

		function exit(proc) {
			return function (callback) {
				var cb = function () {
					status[2] = true;
					proc.kill();

					if (typeof callback === 'function') {
						callback();
					} else {
						grunt.fatal(stackTrace || 'Selenium terminated unexpectedly');
					}
				};

				if (status[2]) {
					cb();
					return;
				}
				stop(cb);
			};
		}

		function data(out) {
			grunt.verbose.writeln('>> '.red + out);
			var lines;

			if (REGEXP_REMOTE.test(out)) {
				server = extract(REGEXP_REMOTE, out, 1).replace(/\/wd\/hub/, '') || server;
			} else if (REGEXP_STARTED.test(out)) {
				// Success
				started(done);
			} else if (REGEXP_RUNNING.test(out)) {
				if (failureTimeout) {
					clearTimeout(failureTimeout);
				}

				// Webdriver instance is already running -> Trying to shutdown
				stop(function (success) {
					if (success) {
						// Shutdown succeeded -> Retry
						new Webdriver(context, options, true);
					} else {
						// Shutdown failed -> Exit
						destroy();
					}
				});
			} else if (REGEXP_FAILURE.test(out)) {
				// Failure -> Exit after timeout. The timeout is needed to
				// enable further console sniffing as the output needed to
				// match `REGEXP_RUNNING` is coming behind the failure message.
				failureTimeout = setTimeout(destroy, 500);
			} else if (REGEXP_EXCEPTION.test(out)) {
				// Failure -> Exit
				grunt.log.writeln('Exception thrown:'.red + ' Going to shut down the Selenium server');
				stackTrace = out;
				destroy();
			} else if (REGEXP_FATAL.test(out)) {
				// Failure -> Exit
				destroy();
			} else if (REGEXP_SESSION_NEW.test(out)) {
				// As there might be race-conditions with multiple logs for
				// `REGEXP_SESSION_NEW` in one log statement, we have to parse
				// parse the data
				lines = out.split(/[\n\r]/);
				lines.forEach(function (line) {
					if (REGEXP_SESSION_NEW.test(line)) {
						sessions++;
						var caps = extract(REGEXP_CAPABILITIES, line, 1);
						grunt.log.writeln('Session created: '.cyan + caps);
					}
				});
			} else if (REGEXP_SESSION_DELETE.test(out)) {
				// As there might be race-conditions with multiple logs for
				// `REGEXP_SESSION_NEW` in one log statement, we have to parse
				// parse the data
				lines = out.split(/[\n\r]/);
				lines.forEach(function (line) {
					if (REGEXP_SESSION_DELETE.test(line)) {
						sessions--;
						var msg = 'Session deleted: '.cyan;

						if (sessions <= 0) {
							// Done -> Exit
							grunt.log.writeln(msg + 'Going to shut down the Selenium server');
							destroy(noop);
						} else {
							grunt.log.writeln(msg + sessions + ' session(s) left');
						}
					}
				});
			}
		}

		start();
	}

	grunt.registerMultiTask('protractor_webdriver', 'grunt plugin for starting Protractor\'s bundled Selenium Webdriver', function () {
		new Webdriver(this, this.options({
			path: '',
			command: DEFAULT_CMD
		}));
	});
};
