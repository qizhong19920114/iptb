'use strict'
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')
const { PassThrough } = require('stream')

const WebSocket = require('ws')
const { createProxyClient } = require('ipfs-postmsg-proxy')
const Hapi = require('hapi')
const multiaddr = require('multiaddr')
const setHeader = require('hapi-set-header')

const { postmsgJS, indexHTML } = require('./assets')

const hash = process.argv[2]
const version = process.argv[3]
const gateway = process.argv[4]

main(`${process.cwd()}`, gateway, hash, version).catch(err =>  {
  console.error(err)
  process.exit(1)
})

function HapiAPI(config, ipfsJS) {
  this.server = undefined
  this.proxySocket = undefined

  this.apiaddr = multiaddr(config.Addresses.API)

  this.start = (callback) => {
    this.server = new Hapi.Server({
      connections: {
        routes: {
          cors: true
        }
      },
      debug: process.env.DEBUG ? {
        request: ['*'],
        log: ['*']
      } : undefined
    })

    // select which connection with server.select(<label>) to add routes
    const { address, port } = this.apiaddr.nodeAddress()
    this.server.connection({
      labels: 'API',
      host: address,
      port,
    })

    this.server.ext('onRequest', (request, reply) => {
      if (request.path.startsWith('/api/') && !request.server.app.ipfs) {
        return reply({
          Message: 'Daemon is not online',
          Code: 0,
          Type: 'error'
        }).code(500).takeover()
      }

      reply.continue()
    })

    // load routes
    require('ipfs/src/http/api/routes')(this.server)

    // serve assets
    this.server.route({
      method: 'GET',
      path: '/',
      handler: (request, reply) => reply(indexHTML())
    })

    this.server.route({
      method: 'GET',
      path: '/postmsg.bundle.js',
      handler: (request, reply) => reply(postmsgJS())
    })

    this.server.route({
      method: 'GET',
      path: '/ipfs.js',
      handler: (request, reply) => reply(ipfsJS())
    })

    // Set default headers
    setHeader(this.server,
      'Access-Control-Allow-Headers',
      'X-Stream-Output, X-Chunked-Output, X-Content-Length')
    setHeader(this.server,
      'Access-Control-Expose-Headers',
      'X-Stream-Output, X-Chunked-Output, X-Content-Length')

    this.server.start(err => {
      if (err) {
        return callback(err)
      }

      const api = this.server.select('API')

      try {
        api.info.ma = multiaddr.fromNodeAddress(api.info, 'tcp').toString()
      } catch (err) {
        return callback(err)
      }

      callback(null)
    })
  }

  this.stop = (callback) => {
    this.server.stop(err => {
      if (err) {
        console.error('There were errors stopping')
        console.error(err)
      }

      callback()
    })
  }
}

async function main(repopath, gateway, hash, version) {
  if (!hash) {
    throw new Error('Not enough information to serve jsipfs, missing hash')
  }

  if (!version) {
    throw new Error('Not enough information to serve jsipfs, missing version')
  }

  const { address: gwaddress, port: gwport } = multiaddr(gateway).nodeAddress()

  gateway = `http://${gwaddress}:${gwport}`

  let config

  try {
    config = fs.readFileSync(`${repopath}/config`)
  } catch (err) {
    throw new Error(`No IPFS repo found in ${repopath}`)
  }

  try {
    config = JSON.parse(config)
  } catch (err) {
    throw new Error(`Could not parse config ${err.message}`)
  }

  const ipfsjspath = `${hash}/${version}/dist/index${process.env.DEBUG ? '.min' : ''}.js`

  let ipfsJS = () => {
    const pass = new PassThrough()
    http.get(`${gateway}/ipfs/${ipfsjspath}`, res => {
      res.pipe(pass)
    })

    return pass
  }

  try {
    await p(cb => fs.access(ipfsjspath, cb))
    ipfsJS = () => {
      return fs.createReadStream(ipfsjspath)
    }
  } catch (err) {
    // ignore
  }

  const api = new HapiAPI(config, ipfsJS)

  await p(api.start)

  // Setup proxy socket
  new WebSocket.Server({
    server: api.server.listener
  })
  .on('connection', async (ws) => {
    // We only accept a single connection
    if (api.server.app.ipfs && !process.env.DEBUG) {
      ws.close()
    }

    const fnmap = new Map()

    ws.send(JSON.stringify({
      __controller: true,
      __type: 'SETUP',
      __payload: config,
    }))

    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data)

      if (msg.__controller && msg.__type == 'READY') {
        api.server.app.ipfs = createProxyClient({
          postMessage: msg => {
            ws.send(JSON.stringify(msg))
          },
          addListener: (name, fn) => {
            const cb = ev => fn({ ...ev, data: JSON.parse(ev.data) })

            fnmap.set(fn, cb)

            ws.addEventListener(name, cb)
          },
          removeListener: (name, fn) => {
            ws.removeEventListener(name, fnmap.get(fn))
          }
        })
      }
    })
  })

  const apiserver = api.server.select('API')

  await p(cb => fs.createWriteStream('./api').on('error', cb).end(apiserver.info.ma, cb))

  const browser = spawn('google-chrome-stable', [
    !process.env.DEBUG ? '--headless' : '',
    `--user-data-dir=${process.cwd()}/data`,
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-translate',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-device-discovery-notifications',
    '--remote-debugging-port=0',
    `${apiserver.info.uri}`
  ])

  browser.on('exit', async (code, signal) => {
    await p(api.stop)
    await p(cb => fs.unlink('./api', cb))

    process.exit(code)
  })

  const signalHandler = signal => {
    browser.kill(signal)
  }

  process.on('SIGINT', signalHandler)
  process.on('SIGTERM', signalHandler)
  process.on('SIGQUIT', signalHandler)
}

function p(fn) {
  return new Promise((resolve, reject) => {
    fn((err, ...rest) => {
      if (err) return reject(err)
      resolve(...rest)
    })
  })
}
