//
// Copyright (c) Microsoft and contributors.  All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

// Test includes
var fs = require('fs');
var path = require('path');
var sinon = require('sinon');
var util = require('util');
var _ = require('underscore');

var keyFiles = require('../../lib/util/keyFiles');
var profile = require('../../lib/util/profile');
var utils = require('../../lib/util/utils');

var executeCommand = require('./cli-executor').execute;
var nockHelper = require('./nock-helper');

exports = module.exports = CLITest;

function CLITest(testPrefix, forceMocked) {
  this.testPrefix = testPrefix;
  this.currentTest = 0;
  this.recordingsFile = __dirname + '/../recordings/' + this.testPrefix + '.nock.js';

  if (forceMocked) {
    this.isMocked = true;
  } else {
    this.isMocked = testPrefix && !process.env.NOCK_OFF;
  }

  this.isRecording = process.env.AZURE_NOCK_RECORD;
}

_.extend(CLITest.prototype, {
  setupSuite: function (callback) {
    if (this.isMocked) {
      process.env.AZURE_ENABLE_STRICT_SSL = false;

      sinon.stub(keyFiles, 'readFromFile', function () {
        return {
          cert: process.env.AZURE_CERTIFICATE,
          key: process.env.AZURE_CERTIFICATE_KEY
        };
      });

      sinon.stub(keyFiles, 'writeToFile', function () {});

      var originalReadFileSync = fs.readFileSync;
      sinon.stub(fs, 'readFileSync', function (filename) {
        switch(path.basename(filename)) {
          case 'config.json':
            return '{ "endpoint": "https://management.core.windows.net",' +
              ' "subscription": "' + process.env.AZURE_SUBSCRIPTION_ID + '" }';
          case 'azureProfile.json':
            return createTestSubscriptionFileContents();
          default:
            return originalReadFileSync(filename, 'utf8');
        }
      });

      var originalPathExistsSync = utils.pathExistsSync;
      sinon.stub(utils, 'pathExistsSync', function (filename) {
        if (path.basename(filename) === 'config.json') {
          return true;
        }

        return originalPathExistsSync(filename);
      });

      if (this.isRecording) {
        fs.writeFileSync(this.recordingsFile,
          '// This file has been autogenerated.\n\n' +
          'exports.scopes = [');
      }
    }

    var originalProfileLoad = profile.load;
    sinon.stub(profile, 'load', function(fileNameOrData) {
      if (!fileNameOrData || fileNameOrData === profile.defaultProfileFile) {
        return originalProfileLoad(JSON.parse(createTestSubscriptionFile()));
      }
      return originalProfileLoad(fileNameOrData);
    });

    profile.current = profile.load();

    // Remove any existing cache files before starting the test
    this.removeCacheFiles();

    callback();
  },

  teardownSuite: function (callback) {
    this.currentTest = 0;

    if (this.isMocked) {
      if (this.isRecording) {
        fs.appendFileSync(this.recordingsFile, '];');
      }

      keyFiles.readFromFile.restore();
      keyFiles.writeToFile.restore();

      if (fs.readFileSync.restore) {
        fs.readFileSync.restore();
      }

      if (utils.pathExistsSync.restore) {
        utils.pathExistsSync.restore();
      }

      if (profile.load.restore) {
        profile.load.restore();
      }

      delete process.env.AZURE_ENABLE_STRICT_SSL;
    }

    callback();
  },

  removeCacheFiles: function () {
    var sitesCachePath = path.join(utils.azureDir(), util.format('sites.%s.json', process.env.AZURE_SUBSCRIPTION_ID));
    if (utils.pathExistsSync(sitesCachePath)) {
      fs.unlinkSync(sitesCachePath);
    }

    var spacesCachePath = path.join(utils.azureDir(), util.format('spaces.%s.json', process.env.AZURE_SUBSCRIPTION_ID));
    if (utils.pathExistsSync(spacesCachePath)) {
      fs.unlinkSync(spacesCachePath);
    }

    var environmentsPath = path.join(utils.azureDir(), 'environment.json');
    if (utils.pathExistsSync(environmentsPath)) {
      fs.unlinkSync(environmentsPath);
    }

    var profilePath = path.join(utils.azureDir(), 'azureProfile.json');
    if (utils.pathExistsSync(profilePath)) {
      fs.unlinkSync(profilePath);
    }
  },

  execute: function (cmd) {
    if (!_.isString(cmd) && !_.isArray(cmd)) {
      throw new Error('First argument needs to be a string or array with the command to execute');
    }

    var args = Array.prototype.slice.call(arguments);

    if (args.length < 2 || !_.isFunction(args[args.length - 1])) {
      throw new Error('Callback needs to be passed as last argument');
    }

    var callback = args[args.length - 1];

    if (_.isString(cmd)) {
      cmd = cmd.split(' ');

      var rep = 1;
      for (var i = 0; i < cmd.length; i++) {
        if (cmd[i] === '%s') {
          cmd[i] = args[rep++];
        }
      }
    }

    if (cmd[0] !== 'node') {
      cmd.unshift('cli.js');
      cmd.unshift('node');
    }

    if (!this.skipSubscription && this.isMocked && !this.isRecording) {
      cmd.push('-s');
      cmd.push(process.env.AZURE_SUBSCRIPTION_ID);
    }

    executeCommand(cmd, callback);
  },

  setupTest: function (callback) {
    nockHelper.nockHttp();

    if (this.isMocked && this.isRecording) {
      // nock recoding
      nockHelper.nock.recorder.rec(true);
    } else if (this.isMocked) {
      // nock playback
      var nocked = require(this.recordingsFile);

      if (this.currentTest < nocked.scopes.length) {
        nocked.scopes[this.currentTest++].forEach(function (createScopeFunc) {
          createScopeFunc(nockHelper.nock);
        });
      } else {
        throw new Error('It appears the ' + this.recordingsFile + ' file has more tests than there are mocked tests. ' +
          'You may need to re-generate it.');
      }
    }

    callback();
  },

  teardownTest: function (callback) {
    if (this.isMocked && this.isRecording) {
      // play nock recording
      var scope = this.scopeWritten ? ',\n[' : '[';
      this.scopeWritten = true;
      var lineWritten;
      nockHelper.nock.recorder.play().forEach(function (line) {
        if (line.indexOf('nock') >= 0) {
          // apply fixups of nock generated mocks

          // do not filter on body as they usual have time related stamps
          line = line.replace(/(\.post\('.*')[^\)]+\)/, '.filteringRequestBody(function (path) { return \'*\';})\n$1, \'*\')');
          line = line.replace(/(\.get\('.*')[^\)]+\)/, '.filteringRequestBody(function (path) { return \'*\';})\n$1, \'*\')');
          line = line.replace(/(\.put\('.*')[^\)]+\)/, '.filteringRequestBody(function (path) { return \'*\';})\n$1, \'*\')');
          line = line.replace(/(\.delete\('.*')[^\)]+\)/, '.filteringRequestBody(function (path) { return \'*\';})\n$1, \'*\')');
          line = line.replace(/(\.merge\('.*')[^\)]+\)/, '.filteringRequestBody(function (path) { return \'*\';})\n$1, \'*\')');
          line = line.replace(/(\.patch\('.*')[^\)]+\)/, '.filteringRequestBody(function (path) { return \'*\';})\n$1, \'*\')');

          scope += (lineWritten ? ',\n' : '') + 'function (nock) { \n' +
            'var result = ' + line + ' return result; }';
          lineWritten = true;
        }
      });
      scope += ']';
      fs.appendFileSync(this.recordingsFile, scope);
      nockHelper.nock.recorder.clear();
    }

    nockHelper.unNockHttp();

    callback();
  },

  /**
  * Generates an unique identifier using a prefix, based on a currentList and repeatable or not depending on the isMocked flag.
  *
  * @param {string} prefix          The prefix to use in the identifier.
  * @param {array}  currentList     The current list of identifiers.
  * @param {bool}   isMocked        Boolean flag indicating if the test is mocked or not.
  * @return {string} A new unique identifier.
  */
  generateId: function (prefix, currentList) {
    if (!currentList) {
      currentList = [];
    }

    while (true) {
      var newNumber;
      if (this.isMocked) {
        // Predictable
        newNumber = prefix + (currentList.length + 1);
        currentList.push(newNumber);

        return newNumber;
      } else {
        // Random
        newNumber = prefix + Math.floor(Math.random() * 10000);
        if (currentList.indexOf(newNumber) === -1) {
          currentList.push(newNumber);

          return newNumber;
        }
      }
    }
  }
});

/**
* A helper function to handle wrapping an existing method in sinon.
*
* @param {ojbect} sinonObj    either sinon or a sinon sandbox instance
* @param {object} object      The object containing the method to wrap
* @param {string} property    property name of method to wrap
* @param {function (function)} setup function that receives the original function,
*                              returns new function that runs when method is called.
* @return {object}             The created stub.
*/
CLITest.wrap = function wrap(sinonObj, object, property, setup) {
  var original = object[property];
  return sinonObj.stub(object, property, setup(original));
};

function createTestSubscriptionFile() {
  var contents = {
    environments: [],
    subscriptions: [
      {
        id: process.env.AZURE_SUBSCRIPTION_ID,
        name: 'testAccount',
        managementEndpointUrl: 'https://management.core.windows.net/',
        managementCertificate: {
          cert: process.env.AZURE_CERTIFICATE,
          key: process.env.AZURE_CERTIFICATE_KEY
        }
      }
    ]
  }
  return JSON.stringify(contents);
}
