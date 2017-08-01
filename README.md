# auction-engine

Spike project for an auction engine

## Getting Started

Install and start mongo

```
$ brew install mongo
$ mongod
```

Copy envrionment, install modules, start server

```
$ cp .env.example .env
$ npm i
$ npm start
```

Point Prediction's Causality urls to this in the .env file

```
CAUSALITY_BIDDERS_BASE_URL=http://localhost:3000
CAUSALITY_BIDDERS_WEBSOCKET_URL=ws://localhost:3000
CAUSALITY_OBSERVERS_BASE_URL=http://localhost:3000
CAUSALITY_OBSERVERS_WEBSOCKET_URL=ws://localhost:3000
```

Start Prediction

```
$ yarn start
```

## Liscence

MIT