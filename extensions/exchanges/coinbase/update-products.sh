#!/usr/bin/env node
// Regenerates products.json for the coinbase adapter from the live
// Coinbase Exchange public products API.
const https = require('https')
const fs = require('fs')
const path = require('path')

https.get('https://api.exchange.coinbase.com/products', (res) => {
  let body = ''
  res.on('data', (c) => body += c)
  res.on('end', () => {
    const prods = JSON.parse(body).filter(p => p.status === 'online')
    const products = prods.map(p => ({
      id: p.id.replace('-', ''),
      asset: p.base_currency,
      currency: p.quote_currency,
      min_size: String(p.base_min_size || '0.00000001'),
      max_size: String(p.base_max_size || '1000000'),
      min_total: '1.0',
      increment: String(p.quote_increment || '0.01'),
      asset_increment: String(p.base_increment || '0.00000001'),
      label: p.base_currency + '/' + p.quote_currency
    }))
    const target = path.resolve(__dirname, 'products.json')
    fs.writeFileSync(target, JSON.stringify(products, null, 2))
    console.log('wrote', target, '(' + products.length + ' products)')
    process.exit()
  })
}).on('error', (e) => { console.error(e); process.exit(1) })
