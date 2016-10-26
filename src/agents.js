var Ledger = require('./ledgers');
var tokens = require('./tokens'); // to make rewire work in probes integration test
var ProbeEngine = require('./probe-engine');
var SettlementEngine = require('./settlement-engine');
var Search = require('./search');
var stringify = require('./stringify');
var messaging = require('./messaging');
var debug = require('./debug');
var messages = require('./messages');

const PROBE_INTERVAL = 1000;

function Agent(myNick) {
  this._settlementEngine = new SettlementEngine();
  this._search = new Search(this._sendMessages.bind(this));
  this._probeEngine = new ProbeEngine();
  this._probeTimer = setInterval(() => this._probeTimerHandler, PROBE_INTERVAL);
  console.log('probe timer created', myNick);
  this._myNick = myNick;
  this._ledgers = {};
  this._sentIOUs = {};
  messaging.addChannel(myNick, (fromNick, msgStr) => {
    return this._handleMessage(fromNick, JSON.parse(msgStr));
  });
}

Agent.prototype._handleProbeEngineOutput = function (output) {
  if (output.cycleFound) {
    return this._settlementEngine.initiateNegotiation(output.cycleFound).then(this._sendMessages.bind(this));
  } else {
    return Promise.all(output.forwardMessages.map(probeMsgObj => {
      console.log('sending probe', probeMsgObj);
      // FIXME: make probeMsgObj and other similar msgObj types more similar
      // (e.g. always call name its fields { toNick: ..., msgObj: ... })
      return messaging.send(this._myNick, probeMsgObj.outNeighborNick, messages.probe(probeMsgObj));
    }));
  }
};

Agent.prototype._probeTimerHandler = function() {
  console.log('probe timer fired', this._myNick);
  var activeNeighbors = this._search.getActiveNeighbors();
  console.log(`probe timer for ${this._myNick}, neighbors:`, activeNeighbors);
  return this._probeEngine.maybeSendProbes(activeNeighbors).then(output => {
    return this._handleProbeEngineOutput(output);
  });
};

Agent.prototype._ensurePeer = function(peerNick) {
  if (typeof this._ledgers[peerNick] === 'undefined') {
    this._ledgers[peerNick] = new Ledger(peerNick, this._myNick);
  }
};

Agent.prototype.sendIOU = function(creditorNick, amount, currency) {
  this._ensurePeer(creditorNick);
  var debt = this._ledgers[creditorNick].createIOU(amount, currency);
  console.log('debt object', debt);
  messaging.send(this._myNick, creditorNick, messages.IOU(debt));
  return new Promise((resolve, reject) => {
    this._sentIOUs[debt.note] = { resolve, reject };
  });
};

Agent.prototype._sendMessages = function(reactions) {
  var promises = [];
  for (var i=0; i<reactions.length; i++) {
    promises.push(messaging.send(this._myNick, reactions[i].toNick, reactions[i].msg));
  }
  return Promise.all(promises);
};

Agent.prototype._handleMessage = function(fromNick, incomingMsgObj) {
  var neighborChanges;
  switch(incomingMsgObj.msgType) {

  case 'IOU':
    // for simplicity, always accept the IOU.
    var debt = incomingMsgObj;
    debt.confirmedByPeer = true;
    this._ensurePeer(fromNick);
    neighborChanges = this._ledgers[fromNick].addDebt(debt);
    return this._sendMessages([{
      toNick: fromNick,
      msg: messages.confirmIOU(debt),
    }]).then(() => {
      debug.log(`${this._myNick} handles neighbor changes after receiving an IOU from ${fromNick}:`);
      return Promise.all(neighborChanges.map(neighborChange => this._search.onNeighborChange(neighborChange))).then(results => {
        var promises = [];
        for (var i=0; i<results.length; i++) {
          for (var j=0; j<results[i].length; j++) {
            promises.push(messaging.send(this._myNick, results[i][j].peerNick, messages.ddcd(results[i][j])));
          }
        }
        return Promise.all(promises);
      });
    });
    // break;

  case 'confirm-IOU':
    neighborChanges = this._ledgers[fromNick].markIOUConfirmed(incomingMsgObj.note);
    debug.log(`${this._myNick} handles neighbor changes after receiving a confirm-IOU from ${fromNick}:`);
    return Promise.all(neighborChanges.map(neighborChange => this._search.onNeighborChange(neighborChange))).then(results => {
      var promises = [];
      for (var i=0; i<results.length; i++) {
        for (var j=0; j<results[i].length; j++) {
          promises.push(messaging.send(this._myNick, results[i][j].peerNick, messages.ddcd(results[i][j])));
        }
      }
      return Promise.all(promises);
    }).then(() => {
      // handle callbacks linked to this sentIOU:
      this._sentIOUs[incomingMsgObj.note].resolve();
      delete this._sentIOUs[incomingMsgObj.note];
    });
    // break;

  case 'dynamic-decentralized-cycle-detection':
    debug.log(`${this._myNick} handles a DCDD message from ${fromNick}:`);
    var results = this._search.onStatusMessage(fromNick, incomingMsgObj.currency, incomingMsgObj.value);
    var promises = [];
    for (var i=0; i<results.length; i++) {
      promises.push(messaging.send(this._myNick, results[i].peerNick, messages.ddcd(results[i])));
    }
    return Promise.all(promises);
    // break;

  case 'probe':
    return this._probeEngine.handleIncomingProbe(fromNick, incomingMsgObj, this._search.getActiveNeighbors()).then(output => {
      return this._handleProbeEngineOutput(output);
    });
    // break;

  default: // msgType is not related to ledgers, ddcd, or probes, but to settlements:
    var peerPair = this._probeEngine.getPeerPair(incomingMsgObj);
    console.log(peerPair);
    var debtorNick = peerPair.inNeighborNick;
    var creditorNick = peerPair.outNeighborNick;
    if (fromNick === debtorNick) {
      fromRole = 'debtor';
    } else if (fromNick === creditorNick) {
      fromRole = 'creditor';
    } else {
      throw new Error(`fromNick matches neither debtorNick nor creditorNick`);
    }
    return this._settlementEngine.generateReactions(fromRole, incomingMsgObj,
        debtorNick, creditorNick).then(this._sendMessages.bind(this));
    // break;
  }
};

module.exports = Agent;
