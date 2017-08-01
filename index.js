const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const httpProxy = require('http-proxy')
const proxy = httpProxy.createProxyServer()
const jwt = require('jsonwebtoken')
const _ = require('lodash')
const calculator = require('./calculator')

const { PORT, HMAC_SECRET, CAUSALITY_URL } = process.env
const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

wss.on('connection', (ws, req) => {
  const send = msg => ws.send(JSON.stringify(msg))
  const broadcast = msg =>
    wss.clients.forEach(client => client.send(JSON.stringify(msg)))

  // The current user state that stores if the connecton is autorized or not,
  // and if authorized it stores the JWT data. This state can be stored
  // inside a variable in the Node process because the websocket connection is
  // coupled to the server. So if the server crashes the websocket connection
  // closes, showing "Lost connection with Auction House", and the client has
  // to re-connect and re-authenticate anyways.
  //
  // One caveat here is that this session data is stored in-memory, which means
  // with enough traffic the server could run out of memory and crash. However,
  // this should be able to be mitigated with typical horizontal and/or
  // vertical scaling of Node webservers as the rest of the
  // non-connection-dependent state is stored in the database.
  let user = {
    authorized: false
  }

  ws.on('message', async message => {
    if (message !== '2') console.log(`Received WS message ${message}`)
    const msg = JSON.parse(message)
    if (msg === 2) {
      // Heartbeat
      send(3)
    } else if (!user.authorized && msg.type !== 'Authorize') {
      // Ensure an unauthorized user can't do anything but authenticate
      send({ type: 'ConnectionUnauthorized' })
    } else if (msg.type === 'Authorize') {
      // Authenticate and send back initial sale state
      try {
        const decoded = jwt.verify(msg.jwt, HMAC_SECRET)
        user = _.assign(
          { authorized: true },
          _.pick(decoded, 'id', 'role', 'bidderId', 'saleId')
        )
        send({ type: 'InitialFullSaleState', operatorConnected: true })
      } catch (err) {
        send({ type: 'ConnectionUnauthorized' })
      }
    } else if (msg.type === 'PostEvent') {
      // Handles new lot events (where the magic happens)
      send({ type: 'CommandSuccessful', wasAccepted: true })
      const lotUpdateBroadcast = await calculator(msg.event)
      broadcast(lotUpdateBroadcast)
    } else {
      // Unknown message
      console.error(`Unknown message ${message}`)
    }
  })
})

// Proxy HTTP requests to Causality & start server
app.use((req, res) => {
  proxy.web(req, res, { target: CAUSALITY_URL, changeOrigin: true })
})
server.listen(3000, () => console.log(`Listening on ${PORT}`))
