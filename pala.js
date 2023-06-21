/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global START_PROPOSER_IDX */
'use strict';

const pala = {};
const RPC_TIMEOUT = 100000;
const MIN_COUNT_OF_VOTES = 1
const FIRST_NODE_IDX = 1
const RPC_LATENCY = 10000;
const ELECTION_TIMEOUT = 150000;
const NUM_SERVERS = 7;
const BATCH_SIZE = 1;
const MIN_VOTES_AMOUNT_FOR_MAKING_DECISION = Math.ceil(NUM_SERVERS * 2 / 3)
const K_BLOCKS = 2

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
  recoveryMessage: 'RecoveryMessage',
  epochChanging: 'EpochChanging'
};

(function() {

const rules = {};
pala.rules = rules;

const sendMessage = (model, message) => {
  message.sendTime = model.time;
  message.recvTime = model.time + RPC_LATENCY
  model.messages.push(message);
};

const sendRequest = (model, request) => {
  request.direction = MESSAGE_DIRECTIONS.request;
  sendMessage(model, request);
};

const sendReply = (model, messageTo, request, reply) => {
  const newReply = {...reply}
  newReply.from = request.to;
  newReply.to = messageTo;
  newReply.type = request.type;
  newReply.direction = MESSAGE_DIRECTIONS.reply;
  newReply.blockToVote = reply?.blockToVote
  newReply.replyBlock = reply?.replyBlock
  sendMessage(model, newReply);
}

const sendMultiReply = (model, request, reply) => {
  model.servers.filter(item => item.id !== request.to).forEach(item => {
    sendReply(model, item.id, request, reply)
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

const isRecoveryEnded = (server) => {
  return Object.values(server.recoveryPaths).reduce((acc, item) => {
    if(item) acc += 1
    return acc
  }, MIN_COUNT_OF_VOTES) === NUM_SERVERS
}

const getNextServerIdx = id => id === NUM_SERVERS ? FIRST_NODE_IDX : (id + 1);

const getNewProposerIdxFromServer = (epoch) => epoch ? epoch % NUM_SERVERS : FIRST_NODE_IDX

const getVotesCount = (server) => Object.values(server.voteGranted).reduce((acc, item) => {
  if(item) {
    acc += 1
  }
  return acc
}, MIN_COUNT_OF_VOTES)

const countVotesForBlock = (server) => Object.values(server.votesForBlock).reduce((acc, item) => {
  if(item === server.blockToVote) {
    acc += 1
  }
  return acc
 }, server.state !== SERVER_STATES.leader
    ? MIN_COUNT_OF_VOTES + 1
    : MIN_COUNT_OF_VOTES
)

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
    commitIndex: 0,
    lastAddedBlockDuringRecovery: -1,
    isRecoveryEndedForCurrentServer: false,
    isRecoveryMessageSent: false,
    epochChangingMessage: { isSent: false, isCanBeSent: true, epochToChange: 0 },
    requestInfo: { isRequestWasSent: false, blocksAfterRequestCount: 0 },
    currentRecoveryId: getNextServerIdx(id),
    recoveryPaths: util.makeMap(peers, false),
    electionAlarm: makeElectionAlarm(0),
    votesForBlock: util.makeMap(peers, -1),
    voteGranted:  util.makeMap(peers, false),
    matchIndex:   util.makeMap(peers, 0),
    nextIndex:    util.makeMap(peers, 1),
    rpcDue:       util.makeMap(peers, 0),
    heartbeatDue: util.makeMap(peers, 0),
  };
};

const onEndOfRecovery = (model, server) => {
    server.isRecoveryEndedForCurrentServer = false
    server.isRecoveryMessageSent = false
    server.currentRecoveryId = getNextServerIdx(server.id)
    server.votesForBlock = util.makeMap(server.peers, -1)
    if(server.lastAddedBlockDuringRecovery >= 0) {
      if(server.blockHistory[server.blockHistory.length - 1]?.block !== server.lastAddedBlockDuringRecovery) {
        server.blockHistory.push({ block: server.lastAddedBlockDuringRecovery, epoch: server.epoch })
      }
      server.lastAddedBlockDuringRecovery = -1
      server.blockToVote = server.blockHistory[server.blockHistory.length - 1].block + 1
    }
    clearServer(model, server)
}

rules.startNewElection = (model, server) => {
  if ((server.state === SERVER_STATES.follower || server.state === SERVER_STATES.leader) &&
      server.electionAlarm <= model.time) {
    clearServer(model, server)
    server.votedFor = server.id;
    server.state = SERVER_STATES.candidate;
    server.rpcDue = util.makeMap(server.peers, model.time)
  }
  if(server.state === SERVER_STATES.recovery && server.electionAlarm <= model.time) {
    if(server.isRecoveryMessageSent) {
      server.isRecoveryEndedForCurrentServer = true
      server.recoveryPaths[server.currentRecoveryId] = true
      server.isRecoveryMessageSent = false
      if(isRecoveryEnded(server)) {
        onEndOfRecovery(model, server)
        return
      }
      const nextRecoveryIndex = getNextServerIdx(server.currentRecoveryId)
      server.currentRecoveryId = nextRecoveryIndex === server.id ? getNextServerIdx(server.id) : nextRecoveryIndex
      return
    }
    if(server.isRecoveryEndedForCurrentServer) {
      if(isRecoveryEnded(server)) {
        onEndOfRecovery(model, server)
        return
      }
      server.isRecoveryEndedForCurrentServer = false
      const nextRecoveryIndex = getNextServerIdx(server.currentRecoveryId)
      server.currentRecoveryId = nextRecoveryIndex === server.id ? getNextServerIdx(server.id) : nextRecoveryIndex
    }
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
  server.epochChangingMessage.isSent = false
  if(isRecoveryEnded(server)) {
    const countOfVotes = getVotesCount(server)
    server.voteGranted = util.makeMap(server.peers, false)
    server.recoveryPaths = util.makeMap(server.peers, false)
    server.isRecoveryEndedForCurrentServer = false
    if(countOfVotes >= MIN_VOTES_AMOUNT_FOR_MAKING_DECISION) {
      server.epochChangingMessage.isSent = true
      server.epoch += 1
      server.epochChangingMessage.isCanBeSent = true
      server.state = server.id === getNewProposerIdxFromServer(server.epoch) ? SERVER_STATES.leader : SERVER_STATES.follower
      clearServer(model, server)
      return
    }
    if(!server.epochChangingMessage.isCanBeSent) {
      server.epochChangingMessage.isCanBeSent = false
      server.epoch = server.epochChangingMessage.serverEpochToChange
    }
    server.state = server.id === getNewProposerIdxFromServer(server.epoch) ? SERVER_STATES.leader : SERVER_STATES.follower
    clearServer(model, server)
  }
};

const clearServer = (model, server) => {
  server.isRecoveryMessageSent = false
  server.votedFor = null
  server.electionAlarm = server.state === SERVER_STATES.stopped ? 0 : makeElectionAlarm(model.time)
  server.rpcDue = util.makeMap(server.peers, model.time + RPC_TIMEOUT)
  server.heartbeatDue = util.makeMap(server.peers, 0)
}

rules.sendRecoveryRequest = (model, server) => {
  if(server.state === SERVER_STATES.recovery && server.electionAlarm <= model.time) {
    const lastBlock = server.blockHistory[server.blockHistory.length - 1]?.block
    sendRequest(model, {
      type: REQUEST_TYPES.recoveryMessage,
      from: server.id,
      to: server.currentRecoveryId,
      epoch: server.epoch,
      neededBlock: Number.isInteger(lastBlock) ? lastBlock + 1 : 0,
    }, true);
    server.isRecoveryMessageSent = true
    server.electionAlarm = makeElectionAlarm( model.time - ELECTION_TIMEOUT / 2)
  }
}

rules.sendEpochChangingRequest = (model, server, recipientId) => {
  if(
      server.epochChangingMessage.isSent &&
      server.epochChangingMessage.isCanBeSent &&
      server.state !== SERVER_STATES.stopped &&
      server.state !== SERVER_STATES.recovery
  ) {
    sendRequest(model, {
      type: REQUEST_TYPES.epochChanging,
      from: server.id,
      to: recipientId,
      epoch: server.epoch,
    }, true);
  }
}

const handleEpochChangingRequest = (model, server, message) => {
  server.voteGranted = util.makeMap(server.peers, false)
  if(server.epoch < message.epoch) {
    if(server.state !== SERVER_STATES.stopped && server.state !== SERVER_STATES.recovery) {
      server.epoch = message.epoch
      const nextLeaderId = getNewProposerIdxFromServer(server.epoch)
      server.state = nextLeaderId === server.id ? SERVER_STATES.leader : SERVER_STATES.follower
      server.electionAlarm = makeElectionAlarm(model.time)
    }
    if(server.state === SERVER_STATES.recovery) {
      server.epochChangingMessage.serverEpochToChange = message.epoch
      server.epochChangingMessage.isCanBeSent = false
    }
  }
}

const handleRecoveryRequest = (model, server, request) => {
  if(server.state === SERVER_STATES.stopped) {
    const requestor = model.servers.find(({id}) => id === request.from)
    requestor.recoveryPaths[server.id] = true
    requestor.isRecoveryMessageSent = false
    requestor.isRecoveryEndedForCurrentServer = true
    requestor.electionAlarm = 0
    return
  }
  sendReply(model, request.from, request, {
    epoch: server.epoch,
    success: true,
    granted: true,
    replyBlock: server.blockHistory.find(item => item.block === request.neededBlock)
  }, true);
}

const handleRecoveryReply = (model, server, reply) => {
  if(server.state === SERVER_STATES.recovery) {
    server.isRecoveryMessageSent = false
    server.recoveryPaths[server.currentRecoveryId] = true
    server.electionAlarm = 0
    if(reply.replyBlock) {
      server.epoch = server.epoch > reply.replyBlock.epoch ? server.epoch : reply.replyBlock.epoch
      server.blockHistory.push(reply.replyBlock)
      server.isRecoveryEndedForCurrentServer = false
      server.blockToVote = server.blockHistory[server.blockHistory.length - 1].block + 1
      server.commitIndex = reply.replyBlock.commitIndex
      server.log = reply.replyBlock.log
      model.servers.forEach(serv => {
        if(serv.state !== SERVER_STATES.stopped) {
          serv.nextIndex[server.id] = server.commitIndex + 1
          serv.matchIndex[server.id] = server.commitIndex
        }
      })
      return
    }
    server.isRecoveryEndedForCurrentServer = true
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
  if(server.state !== SERVER_STATES.stopped) {
    server.votedFor = request.from;
    server.peers.forEach(peerId => {
      server.voteGranted[peerId] =
          (server.epoch === request.epoch &&
              server.id === request.to && peerId === request.from)
          || server.voteGranted[peerId];
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

  rules.sendAppendEntries = (model, server) => {
    server.peers.forEach(peer => {
      if(server.state === SERVER_STATES.leader) {
        if ((server.heartbeatDue[peer] <= model.time)) {
          const prevIndex = server.nextIndex[peer] - 1;
          let lastIndex = Math.max(prevIndex + BATCH_SIZE,
              server.log.length);
          if (server.matchIndex[peer] + 1 < server.nextIndex[peer])
            lastIndex = prevIndex;
          server.votesForBlock = util.makeMap(server.peers, -1)
          sendRequest(model, {
            from: server.id,
            to: peer,
            type: REQUEST_TYPES.appendEntries,
            epoch: server.epoch,
            prevIndex: prevIndex,
            blockToVote: server.blockToVote,
            prevTerm: logTerm(server.log, prevIndex),
            entries: server.log.slice(prevIndex, lastIndex),
            fullEntries: server.log,
            commitIndex: Math.min(server.commitIndex, lastIndex)
          });
          server.rpcDue[peer] = model.time + RPC_TIMEOUT;
          server.heartbeatDue[peer] = model.time + ELECTION_TIMEOUT / 2;
        }
      }
    })
  };

const handleAppendEntriesRequest = (model, server, request) => {
  let success = false;
  let matchIndex = 0;
  if (server.epoch === request.epoch && (server.blockToVote === request.blockToVote || request.entries.length)) {
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
      if(request.fullEntries?.length > server.log?.length) {
        server.log = request.fullEntries
        index += 1
      }
      matchIndex = index;
      server.commitIndex = Math.max(server.commitIndex,
                                    request.commitIndex);
    }
    if(server.state === SERVER_STATES.recovery) return
    sendMultiReply(model, request, {
      epoch: server.epoch,
      success: success,
      matchIndex: matchIndex,
      granted: true,
      blockToVote: server.blockToVote
    });
  }
};

const createBlocksTable = (model, server, reply) => {
  if(server.requestInfo.blocksAfterRequestCount < K_BLOCKS) {
    server.requestInfo.blocksAfterRequestCount += 1
    return;
  }
  if(server.state !== SERVER_STATES.stopped &&
      server.state !== SERVER_STATES.recovery && server.blockToVote === reply.blockToVote) {
    server.commitIndex += 1
    const activePeers = server.peers.filter(servId => model.servers.find(item => item.id === servId)?.state !== SERVER_STATES.stopped )
    activePeers.forEach(peer => server.matchIndex[peer] = Math.max(server.matchIndex[reply.from],
        reply.matchIndex))
    server.requestInfo.isRequestWasSent = false
  }
}

const handleAppendEntriesReply = (model, server, reply) => {
  if((server.epoch === reply.epoch && server.blockToVote === reply.blockToVote) || server.state === SERVER_STATES.recovery) {
    server.blockToVote = reply.blockToVote
    server.votesForBlock[reply.from] = reply.blockToVote
    const isBlockNotarized = countVotesForBlock(server) >= MIN_VOTES_AMOUNT_FOR_MAKING_DECISION
    if(isBlockNotarized) {
      createBlocksTable(model, server, reply)
    }
    if(server.state === SERVER_STATES.recovery && isBlockNotarized) {
      server.lastAddedBlockDuringRecovery = reply.blockToVote
      return
    }
    if (server.state === SERVER_STATES.leader && reply.success && isBlockNotarized) {
        server.electionAlarm = makeElectionAlarm(model.time)
        server.rpcDue = util.makeMap(server.peers, 0)
        const activePeers = server.peers.filter(servId => {
          const foundServer = model.servers.find(item => item.id === servId)
          return foundServer?.state !== SERVER_STATES.stopped &&
              foundServer?.state !== SERVER_STATES.recovery &&
              server.blockToVote - foundServer.blockToVote <= 1
        } )
        activePeers.forEach(peer => server.nextIndex[peer] = Math.max(server.matchIndex[peer], reply.matchIndex + 1))
    }
    if(server.state === SERVER_STATES.follower && isBlockNotarized) {
      server.electionAlarm = makeElectionAlarm(model.time)
    }
    server.votesForBlock[reply.from] = reply.blockToVote
    createBlockHistory(server)
  }
};

const createBlockHistory = (server) => {
  if(countVotesForBlock(server) >= MIN_VOTES_AMOUNT_FOR_MAKING_DECISION) {
    if(server.blockHistory.find(item => item === server.blockToVote)?.id) {
      server.votesForBlock = util.makeMap(server.peers, -1)
      return
    }
    server.blockHistory.push({
      block: server.blockToVote,
      epoch: server.epoch,
      nextIndex: {...server.nextIndex},
      matchIndex: {...server.matchIndex},
      commitIndex: server.commitIndex,
      log: [...server.log]
    })
    server.blockToVote = server.blockHistory[server.blockHistory.length - 1].block + 1
  }
}

const handleMessage = (model, server, message) => {
  if (message.type === REQUEST_TYPES.recoveryMessage) {
    message.direction === MESSAGE_DIRECTIONS.request
        ? handleRecoveryRequest(model, server, message)
        : handleRecoveryReply(model, server, message)
  }
  if (server.state === SERVER_STATES.stopped)
    return
  if (message.type === REQUEST_TYPES.requestVote) {
    message.direction === MESSAGE_DIRECTIONS.request
        ? handleRequestVoteRequest(model, server, message)
        :  handleRequestVoteReply(model, server, message);
    return
  }
  if (message.type === REQUEST_TYPES.appendEntries) {
    message.direction === MESSAGE_DIRECTIONS.request
        ? handleAppendEntriesRequest(model, server, message)
        : handleAppendEntriesReply(model, server, message)
  }
  if(message.type === REQUEST_TYPES.epochChanging) {
    handleEpochChangingRequest(model, server, message)
  }
};

pala.update = (model) => {
  model.servers.forEach((server) => {
    rules.startNewElection(model, server);
    rules.becomeLeader(model, server);
    server.peers.forEach((peer) => {
      rules.sendEpochChangingRequest(model, server, peer)
    })
    rules.advanceCommitIndex(model, server);
    rules.sendAppendEntries(model, server);
    rules.sendRecoveryRequest(model, server)
    server.peers.forEach((peer) => {
      rules.sendRequestVote(model, server, peer);
    });
    if (server.state === SERVER_STATES.candidate) {
      server.state = SERVER_STATES.recovery
      server.recoveryPaths = util.makeMap(server.peers, false)
      server.electionAlarm = 0
    }
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
    server.heartbeatDue = util.makeMap(server.peers, 0)
    model.servers.forEach(serv => {
      if(serv.state !== SERVER_STATES.stopped) {
        serv.requestInfo.blocksAfterRequestCount = 0
        serv.requestInfo.isRequestWasSent = true
      }
    })
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
      return
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
