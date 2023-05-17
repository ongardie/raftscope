/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global START_PROPOSER_IDX */
'use strict';

const pala = {};
const RPC_TIMEOUT = 50000;
const MIN_COUNT_OF_VOTES = 1
const RPC_LATENCY = 15000;
const FAST_RPC_LATENCY = 5000;
const ELECTION_TIMEOUT = 100000;
const NUM_SERVERS = 7;
const BATCH_SIZE = 1;
const MIN_VOTES_AMOUNT_FOR_MAKING_DECISION = Math.floor(NUM_SERVERS * 2 / 3)

const MESSAGE_DIRECTIONS = {
  request: 'request',
  reply: 'reply',
};

const SERVER_STATES = {
  follower: 'follower',
  leader: 'leader',
  stopped: 'stopped',
  candidate: 'candidate',
  recovery: 'recovery'
};

const REQUEST_TYPES = {
  requestVote: 'RequestVote',
  appendEntries: 'AppendEntries',
  recoveryMessage: 'RecoveryMessage'
};

(function() {

const rules = {};
pala.rules = rules;

const sendMessage = (model, message, isFast = false) => {
  message.sendTime = model.time;
  message.recvTime = model.time +
      (isFast ? FAST_RPC_LATENCY : RPC_LATENCY)
  model.messages.push(message);
};

const sendRequest = (model, request, isFast = false) => {
  request.direction = MESSAGE_DIRECTIONS.request;
  sendMessage(model, request, isFast);
};

const sendReply = (model, messageTo, request, reply, isFast = false) => {
  const newReply = {...reply}
  newReply.from = request.to;
  newReply.to = messageTo;
  newReply.type = request.type;
  newReply.direction = MESSAGE_DIRECTIONS.reply;
  newReply.blockToVote = reply?.blockToVote
  newReply.replyBlock = reply?.replyBlock
  sendMessage(model, newReply, isFast);
}

const sendMultiReply = (model, request, reply, isFast = false) => {
  model.servers.filter(item => item.id !== request.to).forEach(item => {
    sendReply(model, item.id, request, reply, isFast)
  })
};

const logTerm = (log, index) => {
  return index < 1 || index > log.length
      ? 0
      : log[index - 1].epoch;
};

const makeElectionAlarm = (now) => {
  return now +  ELECTION_TIMEOUT;
};

const makeRecoveryPathsArray = (peers, id) => {
  const greaterThanId = peers.filter(item => item > id) ?? []
  const lowerThanId = peers.filter(item => item < id) ?? []
  return [ ...greaterThanId, ...lowerThanId ]
}

pala.server = (id, peers, isLeader) => {
  return {
    id: id,
    peers: peers,
    state: isLeader ? SERVER_STATES.leader : SERVER_STATES.follower,
    epoch: 1,
    votedFor: null,
    log: [],
    isLeaderPrevState: isLeader,
    blockHistory: [],
    blockToVote: 0,
    recoveryTimeout: 0,
    electionAlarm: makeElectionAlarm(0),
    votesForBlock: util.makeMap(peers, -1),
    voteGranted:  util.makeMap(peers, false),
    matchIndex:   util.makeMap(peers, 0),
    nextIndex:    util.makeMap(peers, 1),
    rpcDue:       util.makeMap(peers, 0),
    heartbeatDue: util.makeMap(peers, 0),
  };
};

const getNewProposerIdxFromServer = (epoch) => epoch % NUM_SERVERS + 1

const getVotesCount = (server) => Object.values(server.voteGranted).reduce((acc, item) => {
  if(item) {
    acc += 1
  }
  return acc
}, MIN_COUNT_OF_VOTES)

rules.startNewElection = (model, server) => {
  const isLeaderExist = model.servers.some(item => item.state === SERVER_STATES.leader)
  if ((server.state === SERVER_STATES.follower) &&
      server.electionAlarm <= model.time && !isLeaderExist) {
    clearServer(model, server)
    server.votedFor = server.id;
    server.state = SERVER_STATES.candidate;
    server.rpcDue = util.makeMap(server.peers, model.time)
  }
};

rules.sendRequestVote = (model, server, peer) => {
  if (server.state === SERVER_STATES.candidate &&
      server.rpcDue[peer] <= model.time) {
    server.rpcDue[peer] = model.time + RPC_TIMEOUT;
    sendRequest(model, {
      from: server.id,
      to: peer,
      type: REQUEST_TYPES.requestVote,
      epoch: server.epoch,
      lastLogTerm: logTerm(server.log, server.log.length),
      lastLogIndex: server.log.length
    });
  }
};

rules.becomeLeader = (model, server) => {
  const countOfVotes = getVotesCount(server)

  if(countOfVotes >= MIN_VOTES_AMOUNT_FOR_MAKING_DECISION && server.state === SERVER_STATES.candidate) {
      const proposerIdx = getNewProposerIdxFromServer(server.epoch)

      if(server.id === proposerIdx) {
        server.state = SERVER_STATES.leader
        server.nextIndex = util.makeMap(server.peers, server.log.length + 1);
        server.rpcDue       = util.makeMap(server.peers, util.Inf);
        server.heartbeatDue = util.makeMap(server.peers, 0);
        server.electionAlarm = makeElectionAlarm(model.time);
      }
    clearServer(model, server)
    server.epoch += 1
  }
};

const clearServer = (model, server) => {
  server.votedFor = null
  server.electionAlarm = server.state === SERVER_STATES.stopped ? 0 : makeElectionAlarm(model.time)
  server.voteGranted = util.makeMap(server.peers, false)
  server.rpcDue = util.makeMap(server.peers, model.time + RPC_TIMEOUT)
  server.heartbeatDue = util.makeMap(server.peers, model.time + ELECTION_TIMEOUT / 2)
}

rules.sendAppendEntries = (model, server) => {
  server.peers.forEach(peer => {
    if(server.state === SERVER_STATES.leader) {
      if(server.electionAlarm <= model.time) {
        server.state = SERVER_STATES.recovery
        server.electionAlarm = 0
        return
      }
      if ((server.heartbeatDue[peer] <= model.time ||
          (server.nextIndex[peer] <= server.log.length &&
              server.rpcDue[peer] <= model.time))) {
        const prevIndex = server.nextIndex[peer] - 1;
        let lastIndex = Math.min(prevIndex + BATCH_SIZE,
            server.log.length);
        if (server.matchIndex[peer] + 1 < server.nextIndex[peer])
          lastIndex = prevIndex;
        sendRequest(model, {
          from: server.id,
          to: peer,
          type: REQUEST_TYPES.appendEntries,
          epoch: server.epoch,
          prevIndex: prevIndex,
          blockToVote: server.blockToVote,
          prevTerm: logTerm(server.log, prevIndex),
          entries: server.log.slice(prevIndex, lastIndex),
          commitIndex: Math.min(server.commitIndex, lastIndex)
        });
        server.rpcDue[peer] = model.time + RPC_TIMEOUT;
        server.heartbeatDue[peer] = model.time + ELECTION_TIMEOUT / 2;
      }
    }
  })
};

rules.sendRecoveryRequest = (model, server) => {
  if(server.state === SERVER_STATES.recovery && server.electionAlarm <= model.time) {
    const lastBlock = server.blockHistory[server.blockHistory.length - 1]?.block
    sendRequest(model, {
      from: server.id,
      to: server.id + 1,
      type: REQUEST_TYPES.recoveryMessage,
      epoch: server.epoch,
      neededBlock: Number.isInteger(lastBlock) ? lastBlock + 1 : 0,
    }, true);
    server.electionAlarm = makeElectionAlarm(model.time - ELECTION_TIMEOUT / 2)
  }
}

const handleRecoveryRequest = (model, server, request) => {
  sendReply(model, request.from, request, {
    epoch: server.epoch,
    success: true,
    granted: true,
    replyBlock: server.blockHistory.find(item => item.block === request.neededBlock)
  }, true);
}

const handleRecoveryReply = (model, server, reply) => {
  if(reply.replyBlock) {
    server.epoch = reply.replyBlock.epoch
    server.blockHistory.push(reply.replyBlock)
    server.electionAlarm = 0
  }
}

rules.advanceCommitIndex = (model, server) => {
  const matchIndexes = util.mapValues(server.matchIndex).concat(server.log.length);
  matchIndexes.sort(util.numericCompare);
  const n = matchIndexes[Math.floor(NUM_SERVERS / 2)];
  if (server.state === SERVER_STATES.leader &&
      logTerm(server.log, n) === server.epoch) {
    server.commitIndex = Math.max(server.commitIndex, n);
  }
};

const handleRequestVoteRequest = (model, server, request) => {
  if (server.state === SERVER_STATES.candidate) {
    server.votedFor = request.from;
    server.electionAlarm = makeElectionAlarm(model.time);
    server.peers.forEach(peerId => {
      server.voteGranted[peerId] =
          (server.epoch === request.epoch &&
              server.id === request.to &&
          peerId === request.from) || server.voteGranted[peerId];
    })
  }
};

const handleRequestVoteReply = (model, server, reply) => {
  if (server.state === SERVER_STATES.candidate &&
      server.epoch === reply.epoch) {
    server.rpcDue[reply.from] = util.Inf;
    server.voteGranted[reply.from] = reply.granted;
  }
};

const handleAppendEntriesRequest = (model, server, request) => {
  let success = false;
  let matchIndex = 0;
  if (server.epoch === request.epoch) {
    if(
        server.blockToVote !== request.blockToVote
        && server.state !== SERVER_STATES.recovery
        && server.state !== SERVER_STATES.leader
    ) {
      server.state = SERVER_STATES.recovery
      server.electionAlarm = 0
      return
    }
    server.state = SERVER_STATES.follower;
    if (request.prevIndex === 0 ||
        (request.prevIndex <= server.log.length &&
         logTerm(server.log, request.prevIndex) === request.prevTerm)) {
    success = true;
      let index = request.prevIndex;
      for (let i = 0; i < request.entries.length; i += 1) {
        index += 1;
        if (logTerm(server.log, index) !== request.entries[i].epoch) {
          while (server.log.length > index - 1)
            server.log.pop();
          server.log.push(request.entries[i]);
        }
      }
      matchIndex = index;
      server.commitIndex = Math.max(server.commitIndex,
                                    request.commitIndex);
    }
    server.electionAlarm = makeElectionAlarm(model.time);
    sendMultiReply(model, request, {
      epoch: server.epoch,
      success: success,
      matchIndex: matchIndex,
      granted: true,
      blockToVote: server.blockToVote
    });
  }
};

const handleAppendEntriesReply = (model, server, reply) => {
  if(server.epoch === reply.epoch && server.blockToVote === reply.blockToVote) {
    if (server.state === SERVER_STATES.leader) {
      if (reply.success) {
        server.matchIndex[reply.from] = Math.max(server.matchIndex[reply.from],
            reply.matchIndex);
        server.electionAlarm = makeElectionAlarm(model.time)
      }
      server.nextIndex[reply.from] = reply.success ? reply.matchIndex + 1 : Math.max(1, server.nextIndex[reply.from] - 1);
      server.rpcDue[reply.from] = 0;
    }
    server.votesForBlock[reply.from] = reply.blockToVote
    createBlockHistory(server)
  }
};

const countVotesForBlock = (server) => Object.values(server.votesForBlock).reduce((acc, item) => {
  if(item === server.blockToVote) {
    acc += 1
  }
  return acc
}, server.state === SERVER_STATES.follower ? MIN_COUNT_OF_VOTES + 1 : MIN_COUNT_OF_VOTES)

const createBlockHistory = (server) => {
  if(countVotesForBlock(server) >= MIN_VOTES_AMOUNT_FOR_MAKING_DECISION) {
    if(server.blockHistory.find(item => item === server.blockToVote)?.id) {
      server.votesForBlock = util.makeMap(server.peers, -1)
      return
    }
    server.blockHistory.push({ block: server.blockToVote, epoch: server.epoch })
    server.blockToVote = server.blockHistory[server.blockHistory.length - 1].block + 1
  }
}

const handleMessage = (model, server, message) => {
  if (server.state === SERVER_STATES.stopped)
    return;
  if (message.type === REQUEST_TYPES.requestVote) {
    message.direction === MESSAGE_DIRECTIONS.request
        ? handleRequestVoteRequest(model, server, message)
        :  handleRequestVoteReply(model, server, message);
    return;
  }
  if (message.type === REQUEST_TYPES.appendEntries) {
    message.direction === MESSAGE_DIRECTIONS.request
        ? handleAppendEntriesRequest(model, server, message)
        : handleAppendEntriesReply(model, server, message)
  }
  if (message.type === REQUEST_TYPES.recoveryMessage) {
    message.direction === MESSAGE_DIRECTIONS.request
      ? handleRecoveryRequest(model, server, message)
        : handleRecoveryReply(model, server, message)
  }
};

pala.update = (model) => {
  model.servers.forEach((server) => {
    rules.startNewElection(model, server);
    rules.becomeLeader(model, server);
    rules.advanceCommitIndex(model, server);
    rules.sendAppendEntries(model, server);
    rules.sendRecoveryRequest(model, server)
    server.peers.forEach((peer) => {
      rules.sendRequestVote(model, server, peer);
    });
  });
  const deliver = [];
  const keep = [];
  model.messages.forEach((message) => {
    message.recvTime <= model.time
        ? deliver.push(message)
        : keep.push(message)
  });
  model.messages = keep;
  deliver.forEach((message) => {
    model.servers.forEach((server) => {
      if (server.id === message.to) {
        handleMessage(model, server, message);
      }
    });
  });
};

pala.stop = (model, server) => {
  clearServer(model, server)
  server.isLeaderPrevState = server.state === SERVER_STATES.leader
  server.state = SERVER_STATES.stopped;
  server.electionAlarm = 0;
};

pala.resume = (model, server) => {
  clearServer(model, server)
  server.state = server.isLeaderPrevState ? SERVER_STATES.leader : SERVER_STATES.follower;
  server.electionAlarm = makeElectionAlarm(model.time);
};

pala.resumeAll = (model) => {
  model.servers.forEach((server) => {
    pala.resume(model, server);
  });
};

pala.restart = (model, server) => {
  pala.stop(model, server);
  pala.resume(model, server);
};

pala.drop = (model, message) => {
  model.messages = model.messages.filter((msg) => msg !== message);
};

pala.timeout = (model, server) => {
  server.state = SERVER_STATES.follower;
  server.electionAlarm = 0;
  rules.startNewElection(model, server);
};

pala.clientRequest = (model, server) => {
  if (server.state === SERVER_STATES.leader) {
    server.log.push({epoch: server.epoch,
                     value: 'v'});
  }
};

pala.spreadTimers = (model) => {
  const timers = [];
  model.servers.forEach((server) => {
    if (server.electionAlarm > model.time &&
        server.electionAlarm < util.Inf) {
      timers.push(server.electionAlarm);
    }
  });
  timers.sort(util.numericCompare);
  if (timers.length > 1 &&
      timers[1] - timers[0] < RPC_LATENCY) {
    if (timers[0] > model.time + RPC_LATENCY) {
      model.servers.forEach((server) => {
        if (server.electionAlarm === timers[0]) {
          server.electionAlarm -= RPC_LATENCY;
          console.log('adjusted S' + server.id + ' timeout forward');
        }
      });
      return;
    }
    model.servers.forEach((server) => {
      if (server.electionAlarm > timers[0] &&
          server.electionAlarm < timers[0] + RPC_LATENCY) {
        server.electionAlarm += RPC_LATENCY;
        console.log('adjusted S' + server.id + ' timeout backward');
      }
    });
  }
};

pala.alignTimers = (model) => {
  pala.spreadTimers(model);
  const timers = [];
  model.servers.forEach((server) => {
    if (server.electionAlarm > model.time &&
        server.electionAlarm < util.Inf) {
      timers.push(server.electionAlarm);
    }
  });
  timers.sort(util.numericCompare);
  model.servers.forEach((server) => {
    if (server.electionAlarm === timers[1]) {
      server.electionAlarm = timers[0];
      console.log('adjusted S' + server.id + ' timeout forward');
    }
  });
};

pala.setupLogReplicationScenario = (model) => {
  const s1 = model.servers[0];
  pala.restart(model, model.servers[1]);
  pala.restart(model, model.servers[2]);
  pala.restart(model, model.servers[3]);
  pala.restart(model, model.servers[4]);
  pala.timeout(model, model.servers[0]);
  rules.startNewElection(model, s1);
  model.servers[1].epoch = 2;
  model.servers[2].epoch = 2;
  model.servers[3].epoch = 2;
  model.servers[4].epoch = 2;
  model.servers[1].votedFor = 1;
  model.servers[2].votedFor = 1;
  model.servers[3].votedFor = 1;
  model.servers[4].votedFor = 1;
  s1.voteGranted = util.makeMap(s1.peers, true);
  pala.stop(model, model.servers[2]);
  pala.stop(model, model.servers[3]);
  pala.stop(model, model.servers[4]);
  rules.becomeLeader(model, s1);
  pala.clientRequest(model, s1);
  pala.clientRequest(model, s1);
  pala.clientRequest(model, s1);
};
})();
