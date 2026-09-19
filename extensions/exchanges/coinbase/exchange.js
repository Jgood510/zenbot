const ccxt = require('ccxt')
  , path = require('path')
  // eslint-disable-next-line no-unused-vars
  , colors = require('colors')
  , _ = require('lodash')

// Revival note: replaces the old gdax adapter (which used the deprecated
// coinbase-pro lib against the retired Coinbase Pro API). This adapter goes
// through ccxt's unified `coinbase` class (Coinbase Advanced Trade).
module.exports = function coinbase (conf) {
  var public_client, authed_client

  // Honor standard proxy env vars (some sandboxes/VPS setups require an
  // egress proxy); a no-op when unset.
  function proxyOpts () {
    var proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    return proxy ? { httpsProxy: proxy } : {}
  }

  function publicClient () {
    if (!public_client) public_client = new ccxt.coinbase(Object.assign({ 'apiKey': '', 'secret': '', 'enableRateLimit': true, 'options': { 'adjustForTimeDifference': true } }, proxyOpts()))
    return public_client
  }

  function authedClient () {
    if (!authed_client) {
      if (!conf.coinbase || !conf.coinbase.key || conf.coinbase.key === 'YOUR-API-KEY') {
        throw new Error('please configure your Coinbase credentials in ' + path.resolve(__dirname, 'conf.js'))
      }
      authed_client = new ccxt.coinbase(Object.assign({ 'apiKey': conf.coinbase.key, 'secret': conf.coinbase.secret, enableRateLimit: true }, proxyOpts()))
    }
    return authed_client
  }

  /**
  * Convert BTC-USD to BTC/USD
  * @param product_id BTC-USD
  * @returns {string}
  */
  function joinProduct(product_id) {
    let split = product_id.split('-')
    return split[0] + '/' + split[1]
  }

  function retry (method, args, err) {
    if (method !== 'getTrades') {
      console.error(('\nCoinbase API is down! unable to call ' + method + ', retrying in 20s').red)
      if (err) console.error(err)
      console.error(args.slice(0, -1))
    }
    setTimeout(function () {
      exchange[method].apply(exchange, args)
    }, 20000)
  }

  var orders = {}

  var exchange = {
    name: 'coinbase',
    historyScan: 'forward',
    historyScanUsesTime: true,
    makerFee: 0.4,
    takerFee: 0.6,

    getProducts: function () {
      return require('./products.json')
    },

    getTrades: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()
      var startTime, endTime
      if (opts.from) {
        startTime = opts.from
        // ccxt's coinbase.fetchTrades() requires `until` alongside `since`
        // and only returns ~1h windows, so page one hour at a time.
        endTime = Math.min(startTime + 3600000, Date.now())
      } else {
        endTime = parseInt(opts.to, 10)
        startTime = endTime - 3600000
      }

      const symbol = joinProduct(opts.product_id)
      client.fetchTrades(symbol, startTime, undefined, { until: endTime }).then(result => {

        if (result.length === 0 && opts.from) {
          // No trades in this 1h window. Use fetchOHLCV() to detect whether
          // the gap is longer than an hour (done only in forward mode).
          const time_diff = client.options['timeDifference'] || 0
          if (startTime + time_diff < (new Date()).getTime() - 3600000) {
            // startTime is older than 1 hour ago.
            return client.fetchOHLCV(symbol, '1m', startTime, undefined, { until: endTime })
              .then(ohlcv => {
                return ohlcv.length ? client.fetchTrades(symbol, ohlcv[0][0], undefined, { until: endTime }) : []
              })
          }
        }
        return result
      }).then(result => {
        var trades = result.map(trade => ({
          trade_id: trade.id,
          time: trade.timestamp,
          size: parseFloat(trade.amount),
          price: parseFloat(trade.price),
          side: trade.side
        }))
        cb(null, trades)
      }).catch(function (error) {
        console.error('An error occurred', error)
        return retry('getTrades', func_args)
      })

    },

    getBalance: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      client.fetchBalance().then(result => {
        var balance = {asset: 0, currency: 0}
        Object.keys(result).forEach(function (key) {
          if (key === opts.currency) {
            balance.currency = result[key].free + result[key].used
            balance.currency_hold = result[key].used
          }
          if (key === opts.asset) {
            balance.asset = result[key].free + result[key].used
            balance.asset_hold = result[key].used
          }
        })
        cb(null, balance)
      })
        .catch(function (error) {
          console.error('An error occurred', error)
          return retry('getBalance', func_args)
        })
    },

    getQuote: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()
      client.fetchTicker(joinProduct(opts.product_id)).then(result => {
        cb(null, { bid: result.bid, ask: result.ask })
      })
        .catch(function (error) {
          console.error('An error occurred', error)
          return retry('getQuote', func_args)
        })
    },

    getDepth: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()
      client.fetchOrderBook(joinProduct(opts.product_id), opts.limit).then(result => {
        cb(null, result)
      })
        .catch(function(error) {
          console.error('An error ocurred', error)
          return retry('getDepth', func_args)
        })
    },

    cancelOrder: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      client.cancelOrder(opts.order_id, joinProduct(opts.product_id)).then(function (body) {
        if (body && (body.message === 'Order already done' || body.message === 'order not found')) return cb()
        cb(null)
      }, function(err){
        return retry('cancelOrder', func_args, err)
      })
    },

    buy: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      if (typeof opts.post_only === 'undefined') {
        opts.post_only = true
      }
      opts.type = 'limit'
      var args = {}
      if (opts.order_type === 'taker') {
        delete opts.post_only
        opts.type = 'market'
      } else {
        args.timeInForce = 'GTC'
      }
      opts.side = 'buy'
      delete opts.order_type
      var order = {}
      client.createOrder(joinProduct(opts.product_id), opts.type, opts.side, this.roundToNearest(opts.size, opts), opts.price, args).then(result => {
        if (result && result.message === 'Insufficient funds') {
          order = {
            status: 'rejected',
            reject_reason: 'balance'
          }
          return cb(null, order)
        }
        order = {
          id: result ? result.id : null,
          status: 'open',
          price: opts.price,
          size: this.roundToNearest(opts.size, opts),
          post_only: !!opts.post_only,
          created_at: new Date().getTime(),
          filled_size: '0',
          ordertype: opts.order_type
        }
        orders['~' + result.id] = order
        cb(null, order)
      }).catch(function (error) {
        console.error('An error occurred', error)
        return retry('buy', func_args)
      })
    },

    sell: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      if (typeof opts.post_only === 'undefined') {
        opts.post_only = true
      }
      opts.type = 'limit'
      var args = {}
      if (opts.order_type === 'taker') {
        delete opts.post_only
        opts.type = 'market'
      } else {
        args.timeInForce = 'GTC'
      }
      opts.side = 'sell'
      delete opts.order_type
      var order = {}
      client.createOrder(joinProduct(opts.product_id), opts.type, opts.side, this.roundToNearest(opts.size, opts), opts.price, args).then(result => {
        if (result && result.message === 'Insufficient funds') {
          order = {
            status: 'rejected',
            reject_reason: 'balance'
          }
          return cb(null, order)
        }
        order = {
          id: result ? result.id : null,
          status: 'open',
          price: opts.price,
          size: this.roundToNearest(opts.size, opts),
          post_only: !!opts.post_only,
          created_at: new Date().getTime(),
          filled_size: '0',
          ordertype: opts.order_type
        }
        orders['~' + result.id] = order
        cb(null, order)
      }).catch(function (error) {
        console.error('An error occurred', error)
        return retry('sell', func_args)
      })
    },

    roundToNearest: function(numToRound, opts) {
      var numToRoundTo = _.find(this.getProducts(), { 'asset': opts.product_id.split('-')[0], 'currency': opts.product_id.split('-')[1] }).min_size
      numToRoundTo = 1 / (numToRoundTo)

      return Math.floor(numToRound * numToRoundTo) / numToRoundTo
    },

    getOrder: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      var order = orders['~' + opts.order_id]
      client.fetchOrder(opts.order_id, joinProduct(opts.product_id)).then(function (body) {
        if (body.status !== 'open' && body.status !== 'canceled') {
          order.status = 'done'
          order.done_at = new Date().getTime()
          order.price = parseFloat(body.price)
          order.filled_size = parseFloat(body.amount) - parseFloat(body.remaining)
          return cb(null, order)
        }
        cb(null, order)
      }, function(err) {
        return retry('getOrder', func_args, err)
      })
    },

    getCursor: function (trade) {
      return (trade.time || trade)
    }
  }
  return exchange
}
