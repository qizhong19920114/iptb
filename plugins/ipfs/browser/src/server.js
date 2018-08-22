'use strict'
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')
const { PassThrough } = require('stream')

const WebSocket = require('ws')
const Hapi = require('hapi')
const setHeader = require('hapi-set-header')
const debug = require('debug')
const multiaddr = require('multiaddr')
const apiRoutes = require('ipfs/src/http/api/routes')
const { createProxyClient } = require('ipfs-postmsg-proxy')

const assets = require('./assets')

main(process.env.IPFS_PATH || process.cwd()).catch(err =>  {
  console.error(err)
  process.exit(1)
})

function HttpAPI(config, routes) {
  this.server = undefined
  this.apiaddr = multiaddr(config.Addresses.API)

  this.start = (callback) => {
    console.log('starting')
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

    const api = this.apiaddr.nodeAddress()

    // select which connection with server.select(<label>) to add routes
    this.server.connection({
      host: api.address,
      port: api.port,
      labels: 'API',
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
    routes.forEach(r => r(this.server))

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

      callback()
    })
  }

  this.stop = (callback) => {
    console.log('stopping')
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
  let config

  console.log('reading config')

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

  const httpapi = new HttpAPI(config, [
    (server) => apiRoutes(server),
    (server) => {
      // Currently serving everything off of the same connection
      // that the API is running on
      const apiserver = server.select('API')
      const { postmsgJS, indexHTML, ipfsJS } = assets

      apiserver.route({
        method: 'GET',
        path: '/',
        handler: (request, reply) => reply(indexHTML())
      })

      apiserver.route({
        method: 'GET',
        path: '/postmsg.bundle.js',
        handler: (request, reply) => reply(postmsgJS())
      })

      apiserver.route({
        method: 'GET',
        path: '/ipfs.js',
        handler: (request, reply) => reply(ipfsJS())
      })
    }
  ])

  await p(httpapi.start)

  // Setup proxy socket
  new WebSocket.Server({
    server: httpapi.server.listener
  })
  .on('connection', socket => {
    console.log('new websocket connection')

    // We only accept a single connection except when
    // the debug env is set to allow for refreshing of
    // the browser
    if (httpapi.server.app.ipfs != undefined) {
      console.log('websocket proxy already started, closing new connection')
      return socket.close()
    }

    // Set instance to another falsey value, but not undefined so that
    // our middleware hook will error correctly till the proxy is setup
    httpapi.server.app.ipfs = null

    // Websockets can only send buffer like data, but postmsg-proxy
    // works on object data. For every listener we have to wrap it
    // in a function which parses the buffer prior to passing it into
    // the original listener. This maps contains the mapping so that
    // we can properly remove listeners
    const fnmap = new Map()

    // Send the initial setup with the ipfs config to the browser
    socket.send(JSON.stringify({
      __controller: true,
      __type: 'SETUP',
      __payload: config,
    }))

    socket.addEventListener('close', () => {
      console.log('websocket connection closed')
      fnmap.clear()
      httpapi.server.app.ipfs = undefined
    })

    // One time message receiver that constructs the
    // postmsg-proxy client once the ipfs node in the browser is
    // running
    socket.addEventListener('message', ev => {
      if (httpapi.server.app.ipfs) {
        return
      }

      const msg = JSON.parse(ev.data)

      if (msg.__controller && msg.__type == 'READY') {
        console.log('creating new ipfs websocket proxy')
        httpapi.server.app.ipfs = createProxyClient({
          postMessage: msg => {
            socket.send(JSON.stringify(msg))
          },
          addListener: (name, fn) => {
            const cb = ev => fn({ ...ev, data: JSON.parse(ev.data) })

            fnmap.set(fn, cb)

            socket.addEventListener(name, cb)
          },
          removeListener: (name, fn) => {
            socket.removeEventListener(name, fnmap.get(fn))
          }
        })
      }
    })
  })

  const apiserver = httpapi.server.select('API')

  console.log('api running on %s', apiserver.info.ma)
  console.log('writing api file to repo')

  await p(cb => {
    fs.createWriteStream('./api')
      .on('error', cb)
      .end(apiserver.info.ma, cb)
  })

  console.log('starting browser')

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
    console.log('browser exited')

    await p(httpapi.stop)
    await p(cb => fs.unlink('./api', cb))

    process.exit(code)
  })

  const signalHandler = signal => {
    console.log('received signal %s', signal)
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
