const pmongo = require('promised-mongo')
const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const httpProxy = require('http-proxy')
const proxy = httpProxy.createProxyServer()
const jwt = require('jsonwebtoken')
const _ = require('lodash')
const uid = require('uid')

const {
  DB_URL,
  PORT,
  HMAC_SECRET,
  CAUSALITY_URL,
  INCREMENT_POLICY: IP
} = process.env
const { ObjectId } = pmongo
const INCREMENT_POLICY = JSON.parse(IP)
const db = pmongo(DB_URL, ['lots'])
const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

app.use((req, res) => {
  proxy.web(req, res, { target: CAUSALITY_URL, changeOrigin: true })
})

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
      const lotId = ObjectId(msg.event.lotId)
      const eventId = uid()
      // Send an initial "accepted" message
      send({ type: 'CommandSuccessful', wasAccepted: true })
      // Validate the event can be appended and saved to database
      // TODO: Validation code
      const lot = (await db.lots.findOne({ _id: lotId })) || { events: [] }
      const lotEvents = [...lot.events, _.assign(msg.event, { eventId })]
      await db.lots.update(
        { _id: lotId },
        { $set: { events: lotEvents } },
        { upsert: true }
      )
      // Reduce lot event list into the Causality LotUpdateBroadcast data model.
      // In the future one could imagine going further and reducing this list
      // of events into an even more useful derived state such as `youreWinning`
      // using the `user` state above to compare with the winning bid.
      const bids = lotEvents.filter(
        event => event.type === 'FirstPriceBidPlaced'
      )
      const winningBid = bids.length
        ? bids.reduce((currentWinningBid, bid) => {
          const isHigher = bid.amountCents >= currentWinningBid.amountCents
          const isAccepted =
              bid.bidder.type === 'OfflineBidder' ||
              lotEvents.filter(
                event =>
                  event.type === 'CompositeOnlineBidConfirmed' &&
                  event.eventId === bid.eventId
              ).length
          return isHigher && isAccepted ? bid : currentWinningBid
        })
        : null
      const floorBids = bids.filter(
        event => event.bidder.type === 'OfflineBidder'
      )
      const winningFloorBid = floorBids.length
        ? floorBids.reduce((currentWinningBid, bid) => {
          const isHigher = bid.amountCents >= currentWinningBid.amountCents
          return isHigher ? bid : currentWinningBid
        })
        : null
      const currentIncrement = INCREMENT_POLICY.filter(
        increment =>
          winningBid.amountCents >= increment.from &&
          winningBid.amountCents <= increment.to
      )[0]
      const derivedLotState = {
        askingPriceCents: winningBid
          ? winningBid.amountCents + currentIncrement.amount
          : currentIncrement.amount,
        sellingPriceCents: winningBid
          ? winningBid.amountCents
          : currentIncrement.amount,
        bidCount: bids.length ? bids.reduce(count => count + 1, 0) : 0,
        floorAskingPriceCents: winningFloorBid || winningBid
          ? (winningFloorBid || winningBid).amountCents +
              currentIncrement.amount
          : currentIncrement.amount,
        floorSellingPriceCents: winningFloorBid
          ? winningFloorBid.amountCents
          : null,
        floorWinningBidder: winningFloorBid ? winningFloorBid.bidder : null,
        winningBidEventId: winningBid.eventId,
        // TODO: Stubbed data below—should also reduce state like above
        biddingStatus: 'OnBlock',
        floorIsOpen: true,
        soldStatus: 'ForSale'
      }
      const events = lotEvents.reduce((map, event) => {
        return _.assign(map, { [event.eventId]: event })
      }, {})
      const lotUpdateBroadcast = {
        type: 'LotUpdateBroadcast',
        lotId: lotId,
        fullEventOrder: _.map(lotEvents.reverse(), 'eventId'),
        derivedLotState,
        events
      }
      // Emit LotUpdateBroadcast (could add things like RabbitMQ here too)
      broadcast(lotUpdateBroadcast)
    } else {
      // Unknown websocket message
      console.error(`Unknown message ${message}`)
    }
  })
})

server.listen(3000, () => console.log(`Listening on ${PORT}`))
