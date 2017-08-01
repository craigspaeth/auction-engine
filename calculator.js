const _ = require('lodash')
const pmongo = require('promised-mongo')
const uid = require('uid')

const { ObjectId } = pmongo
const { DB_URL, INCREMENT_POLICY: IP } = process.env
const INCREMENT_POLICY = JSON.parse(IP)
const db = pmongo(DB_URL, ['lots'])

/**
 * Main calculator function that takes in a new lot event, pulls the lot event
 * list from the database, reduces the event list into derived state, and
 * finally aggregates that into the full LotUpdateBroadcast websocket message.
 *
 * @param  {[Object]} event The `event` data from the PostEvent over websockets
 * @return {[Object]} LotUpdateBroadcast JSON sent over websockets
 */
module.exports = async event => {
  const lotId = ObjectId(event.lotId)
  const eventId = uid()

  // Validate the event can be appended and saved to database
  // TODO: Validation code
  const lot = (await db.lots.findOne({ _id: lotId })) || { events: [] }
  const le = [...lot.events, _.assign(event, { eventId })]
  await db.lots.update(
    { _id: lotId },
    { $set: { events: le } },
    { upsert: true }
  )

  // Reduce lot event list into the Causality LotUpdateBroadcast data model.
  // In the future one could imagine going further and reducing this list
  // of events into an even more useful derived state such as `youreWinning`
  // using the `user` state from index.js:32 to compare with the `winningBid`.
  const derivedLotState = {
    askingPriceCents: askingPriceCents(le),
    sellingPriceCents: sellingPriceCents(le),
    bidCount: bidCount(le),
    floorAskingPriceCents: floorAskingPriceCents(le),
    floorSellingPriceCents: floorSellingPriceCents(le),
    floorWinningBidder: floorWinningBidder(le),
    winningBidEventId: winningBidEventId(le),
    // TODO: Stubbed data below—should also reduce state like above
    biddingStatus: 'OnBlock',
    floorIsOpen: true,
    soldStatus: 'ForSale'
  }
  const events = le.reduce((map, event) => {
    return _.assign(map, { [event.eventId]: event })
  }, {})
  const lotUpdateBroadcast = {
    type: 'LotUpdateBroadcast',
    lotId: lotId,
    fullEventOrder: _.map(le.reverse(), 'eventId'),
    derivedLotState,
    events
  }
  return lotUpdateBroadcast
}

const winningBidEventId = le => winningBid(le).eventId

const floorWinningBidder = le =>
  (winningFloorBid(le) ? winningFloorBid(le).bidder : null)

const floorSellingPriceCents = le =>
  (winningFloorBid(le) ? winningFloorBid(le).amountCents : null)

const bidCount = le =>
  (bids(le).length ? bids(le).reduce(count => count + 1, 0) : 0)

const sellingPriceCents = le =>
  (winningBid(le) ? winningBid(le).amountCents : currentIncrement(le).amount)

const askingPriceCents = le =>
  (winningBid(le)
    ? winningBid(le).amountCents + currentIncrement(le).amount
    : currentIncrement(le).amount)

const floorAskingPriceCents = le =>
  (winningFloorBid(le) || winningBid(le)
    ? (winningFloorBid(le) || winningBid(le)).amountCents +
        currentIncrement(le).amount
    : currentIncrement(le).amount)

const bids = le => le.filter(event => event.type === 'FirstPriceBidPlaced')

const winningBid = le =>
  (bids(le).length
    ? bids(le).reduce((currentWinningBid, bid) => {
      const isHigher = bid.amountCents >= currentWinningBid.amountCents
      const isAccepted =
          bid.bidder.type === 'OfflineBidder' ||
          le.filter(
            event =>
              event.type === 'CompositeOnlineBidConfirmed' &&
              event.eventId === bid.eventId
          ).length
      return isHigher && isAccepted ? bid : currentWinningBid
    })
    : null)

const floorBids = le =>
  bids(le).filter(event => event.bidder.type === 'OfflineBidder')

const winningFloorBid = le =>
  (floorBids(le).length
    ? floorBids(le).reduce((currentWinningBid, bid) => {
      const isHigher = bid.amountCents >= currentWinningBid.amountCents
      return isHigher ? bid : currentWinningBid
    })
    : null)

const currentIncrement = le =>
  INCREMENT_POLICY.filter(
    increment =>
      winningBid(le).amountCents >= increment.from &&
      winningBid(le).amountCents <= increment.to
  )[0]
