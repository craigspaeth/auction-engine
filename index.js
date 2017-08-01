const pmongo = require('promised-mongo')
const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const httpProxy = require('http-proxy')
const proxy = httpProxy.createProxyServer()
const jwt = require('jsonwebtoken')
const uid = require('uid')
const _ = require('lodash')

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
      // Handles new events added to the lot event list. This is where the
      // auction calculator and derived state is run.
      //
      // Send an initial "accepted" message
      send({ type: 'CommandSuccessful', wasAccepted: true })
      const _id = ObjectId(msg.event.lotId)
      // Create the lot if it doesn't exist
      // TODO: Sync initial lot data on bootup instead
      await db.lots.update(
        { _id },
        { $setOnInsert: { events: [] } },
        { upsert: true }
      )
      // Transform the event into a database appropriate model
      const event = {
        FirstPriceBidPlaced: () => ({
          id: uid(),
          type: 'bid',
          amount: msg.event.amountCents,
          user: _.pick(user, 'id', 'role', 'bidderId')
        })
      }[msg.event.type]()
      // Validate the event can be appended and saved to database
      // TODO: Validation code
      const lot = await db.lots.findOne({ _id })
      const lotEvents = lot.events.concat(event)
      await db.lots.update({ _id }, { $set: { events: lotEvents } })
      // Reduce lot event list into the Causality LotUpdateBroadcast data model.
      // In the future one could imagine going further and reducing this list
      // of events into an even more useful derived state such as `youreWinning`
      // using the `user` state above to compare with the winning bid in the
      // event list (itself a function of the event list).
      const winningBid = lotEvents
        .filter(event => event.type === 'bid')
        .reduce((winningBid, bid) => {
          return bid.amount >= winningBid.amount ? bid : winningBid
        })
      const currentIncrement = INCREMENT_POLICY.filter(
        increment =>
          winningBid.amount >= increment.from &&
          winningBid.amount <= increment.to
      )[0]
      const askingPrice = winningBid.amount + currentIncrement.amount
      const totalBids = lotEvents
        .filter(event => event.type === 'bid')
        .reduce(count => count + 1, 0)
      const derivedLotState = {
        askingPriceCents: askingPrice,
        sellingPriceCents: winningBid.amount,
        bidCount: totalBids,
        floorAskingPriceCents: askingPrice,
        floorSellingPriceCents: winningBid.amount,
        floorWinningBidder: winningBid.user,
        winningBidEventId: winningBid.id,
        // TODO: Stubbed data below—should also reduce state like above
        biddingStatus: 'OnBlock',
        floorIsOpen: true,
        soldStatus: 'ForSale'
      }
      const events = lotEvents
        .map(event => {
          if (event.type === 'bid') {
            return {
              eventId: event.id,
              amountCents: event.amount,
              bidder: {
                bidderId: event.user.bidderId,
                paddleNumber: event.user.bidderId,
                type: {
                  bidder: 'ArtsyBidder',
                  operator: 'ArtsyOperator',
                  observer: 'ArtsyObserver'
                }[event.user.role]
              },
              lotId: _id,
              type: 'FirstPriceBidPlaced'
            }
          } else {
            throw new Error(`Unknown lot event ${JSON.stringify(event)}`)
          }
        })
        .reduce((map, event) => {
          return _.assign(map, { [event.eventId]: event })
        }, {})
      const lotUpdateBroadcast = {
        type: 'LotUpdateBroadcast',
        lotId: _id,
        fullEventOrder: _.map(lotEvents, 'id'),
        derivedLotState,
        events
      }
      // Emit LotUpdateBroadcast (could add things like RabbitMQ here too)
      send(lotUpdateBroadcast)
    } else {
      // Unknown websocket message
      console.error(`Unknown message ${message}`)
    }
  })
})

server.listen(3000, () => console.log(`Listening on ${PORT}`))
