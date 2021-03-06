'use strict';

// See: https://github.com/ethereum/wiki/wiki/JSON-RPC

var Provider = require('./provider.js');

var utils = (function() {
    var convert = require('../utils/convert');
    return {
        defineProperty: require('../utils/properties').defineProperty,

        hexlify: convert.hexlify,
        isHexString: convert.isHexString,
        hexStripZeros: convert.hexStripZeros,

        toUtf8Bytes: require('../utils/utf8').toUtf8Bytes,

        getAddress: require('../utils/address').getAddress,
    }
})();

var errors = require('../utils/errors');

function timer(timeout) {
    return new Promise(function(resolve) {
        setTimeout(function() {
            resolve();
        }, timeout);
    });
}

function getResult(payload) {
    if (payload.error) {
        var error = new Error(payload.error.message);
        error.code = payload.error.code;
        error.data = payload.error.data;

        if(payload.error.message == 'insufficient funds for gas * price + value'){
            error.message = '账户余额不足，无法进行当前操作'
        }
        throw error;
    }

    return payload.result;
}

function stripHexZeros(value) {
    while (value.length > 3 && value.substring(0, 3) === '0x0') {
        value = '0x' + value.substring(3);
    }
    return value;
}

function getTransaction(transaction) {
    var result = {};

    for (var key in transaction) {
        result[key] = utils.hexlify(transaction[key]);
    }

    // Some nodes (INFURA ropsten; INFURA mainnet is fine) don't like extra zeros.
    ['gasLimit', 'gasPrice', 'nonce', 'value'].forEach(function(key) {
        if (!result[key]) { return; }
        result[key] = utils.hexStripZeros(result[key]);
    });

    // Transform "gasLimit" to "gas"
    if (result.gasLimit != null && result.gas == null) {
        result.gas = result.gasLimit;
        delete result.gasLimit;
    }

    return result;
}

function JsonRpcSigner(provider, address) {
    errors.checkNew(this, JsonRpcSigner);

    utils.defineProperty(this, 'provider', provider);

    // Statically attach to a given address
    if (address) {
        utils.defineProperty(this, 'address', address);
        utils.defineProperty(this, '_syncAddress', true);

    } else {
        Object.defineProperty(this, 'address', {
            enumerable: true,
            get: function() {
                errors.throwError('no sync sync address available; use getAddress', errors.UNSUPPORTED_OPERATION, { operation: 'address' });
            }
        });
        utils.defineProperty(this, '_syncAddress', false);
    }
}

utils.defineProperty(JsonRpcSigner.prototype, 'getAddress', function() {
    if (this._syncAddress) { return Promise.resolve(this.address); }

    return this.provider.send('eth_accounts', []).then(function(accounts) {
        if (accounts.length === 0) {
            errors.throwError('no accounts', errors.UNSUPPORTED_OPERATION, { operation: 'getAddress' });
        }
        return utils.getAddress(accounts[0]);
    });
});

utils.defineProperty(JsonRpcSigner.prototype, 'getBalance', function(blockTag) {
    var provider = this.provider;
    return this.getAddress().then(function(address) {
        return provider.getBalance(address, blockTag);
    });
});

utils.defineProperty(JsonRpcSigner.prototype, 'getTransactionCount', function(blockTag) {
    var provider = this.provider;
    return this.getAddress().then(function(address) {
        return provider.getTransactionCount(address, blockTag);
    });
});

utils.defineProperty(JsonRpcSigner.prototype, 'sendTransaction', function(transaction) {
    var provider = this.provider;
    transaction = getTransaction(transaction);
    return this.getAddress().then(function(address) {
        transaction.from = address.toLowerCase();
        return provider.send('eth_sendTransaction', [ transaction ]).then(function(hash) {
            return new Promise(function(resolve, reject) {
                function check() {
                    provider.getTransaction(hash).then(function(transaction) {
                        if (!transaction) {
                            setTimeout(check, 1000);
                            return;
                        }
                        resolve(transaction);
                    });
                }
                check();
            });
        });
    });
});

utils.defineProperty(JsonRpcSigner.prototype, 'signMessage', function(message) {
    var provider = this.provider;

    var data = ((typeof(message) === 'string') ? utils.toUtf8Bytes(message): message);
    return this.getAddress().then(function(address) {

        // https://github.com/ethereum/wiki/wiki/JSON-RPC#eth_sign
        return provider.send('eth_sign', [ address.toLowerCase(), utils.hexlify(data) ]);
    });
});

utils.defineProperty(JsonRpcSigner.prototype, 'unlock', function(password) {
    var provider = this.provider;

    return this.getAddress().then(function(address) {
        return provider.send('personal_unlockAccount', [ address.toLowerCase(), password, null ]);
    });
});


function HttpRpcProvider(url, network) {
    errors.checkNew(this, HttpRpcProvider);

    if (arguments.length == 1) {
        if (typeof(url) === 'string') {
            try {
                network = Provider.getNetwork(url);
                url = null;
            } catch (error) { }
        } else if (url && url.url == null) {
            network = url;
            url = null;
        }
    }

    Provider.call(this, network);

    if (!url) { url = 'http://localhost:8545'; }

    utils.defineProperty(this, 'url', url);
}
Provider.inherits(HttpRpcProvider);

utils.defineProperty(HttpRpcProvider.prototype, 'getSigner', function(address) {
    return new JsonRpcSigner(this, address);
});

utils.defineProperty(HttpRpcProvider.prototype, 'listAccounts', function() {
    return this.send('eth_accounts', []).then(function(accounts) {
        accounts.forEach(function(address, index) {
            accounts[index] = utils.getAddress(address);
        });
        return accounts;
    });
});

utils.defineProperty(HttpRpcProvider.prototype, 'send', function(method, params) {
    /* var request = { */
        // method: method,
        // params: params,
        // id: 42,
        // jsonrpc: "2.0"
    /* }; */

    // return Provider.fetchJSON(this.url, JSON.stringify(request), getResult);

    var url = this.url + '/chain/' + method;
    return Provider.fetchJSON(url, JSON.stringify(params), getResult);
});

utils.defineProperty(HttpRpcProvider.prototype, 'perform', function(method, params) {
    switch (method) {
        case 'getBlockNumber':
            return this.send('get_block_number', []);

        case 'getGasPrice':
            return this.send('get_gas_price', []);

        case 'getBalance':
            var blockTag = params.blockTag;
            if (utils.isHexString(blockTag)) { blockTag = stripHexZeros(blockTag); }
            // return this.send('eth_getBalance', [params.address, blockTag]);
            return this.send('get_balance', { address : params.address, blockTag : blockTag });

        case 'getTransactionCount':
            var blockTag = params.blockTag;
            if (utils.isHexString(blockTag)) { blockTag = stripHexZeros(blockTag); }
            // return this.send('eth_getTransactionCount', [params.address, blockTag]);
            return this.send('get_transaction_count', { address : params.address, blockTag: blockTag });

        case 'getCode':
            var blockTag = params.blockTag;
            if (utils.isHexString(blockTag)) { blockTag = stripHexZeros(blockTag); }
            return this.send('eth_getCode', [params.address, blockTag]);

        case 'getStorageAt':
            var position = params.position;
            if (utils.isHexString(position)) { position = stripHexZeros(position); }
            var blockTag = params.blockTag;
            if (utils.isHexString(blockTag)) { blockTag = stripHexZeros(blockTag); }
            return this.send('eth_getStorageAt', [params.address, position, blockTag]);

        case 'sendTransaction':
            // return this.send('eth_sendRawTransaction', [params.signedTransaction]);
            return this.send('send_transaction', { transaction : params.signedTransaction });

        case 'getBlock':
            if (params.blockTag) {
                var blockTag = params.blockTag;
                if (utils.isHexString(blockTag)) { blockTag = stripHexZeros(blockTag); }
                return this.send('eth_getBlockByNumber', [blockTag, false]);
            } else if (params.blockHash) {
                return this.send('eth_getBlockByHash', [params.blockHash, false]);
            }
            return Promise.reject(new Error('invalid block tag or block hash'));

        case 'getTransaction':
            // return this.send('eth_getTransactionByHash', [params.transactionHash]);
            return this.send('get_transaction_by_hash', { tx_hash: params.transactionHash });

        case 'getTransactionReceipt':
            return this.send('eth_getTransactionReceipt', [params.transactionHash]);

        case 'call':
            return this.send('get_call', [getTransaction(params.transaction), 'latest']);

        case 'estimateGas':
            // return this.send('eth_estimateGas', [getTransaction(params.transaction)]);
            return this.send('get_estimate_gas', getTransaction(params.transaction));

        case 'getLogs':
            var _filter = params.filter;
            if (utils.isHexString(_filter.fromBlock)) { _filter.fromBlock = stripHexZeros(_filter.fromBlock); }
            if (utils.isHexString(_filter.fromBlock)) { _filter.toBlock = stripHexZeros(_filter.toBlock); }
            return this.send('get_logs', [_filter]);
        default:
            break;
    }

    return Promise.reject(new Error('not implemented - ' + method));

});

utils.defineProperty(HttpRpcProvider.prototype, '_startPending', function() {
    if (this._pendingFilter != null) { return; }
    var self = this;

    var pendingFilter = this.send('eth_newPendingTransactionFilter', []);
    this._pendingFilter = pendingFilter;

    pendingFilter.then(function(filterId) {
        function poll() {
            self.send('eth_getFilterChanges', [ filterId ]).then(function(hashes) {
                if (self._pendingFilter != pendingFilter) { return; }

                var seq = Promise.resolve();
                hashes.forEach(function(hash) {
                    seq = seq.then(function() {
                        return self.getTransaction(hash).then(function(tx) {
                            self.emit('pending', tx);
                        });
                    });
                });

                return seq.then(function() {
                    return timer(1000);
                });
            }).then(function() {
                if (self._pendingFilter != pendingFilter) {
                    self.send('eth_uninstallFilter', [ filterIf ]);
                    return;
                }
                setTimeout(function() { poll(); }, 0);
            });
        }
        poll();

        return filterId;
    });
});

utils.defineProperty(HttpRpcProvider.prototype, '_stopPending', function() {
    this._pendingFilter = null;
});

utils.defineProperty(HttpRpcProvider, '_hexlifyTransaction', function(transaction) {
    return getTransaction(transaction);
});

module.exports = HttpRpcProvider;
