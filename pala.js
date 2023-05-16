/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
'use strict';

const pala = {};
const RPC_TIMEOUT = 50000;
const MIN_RPC_LATENCY = 10000;
const MAX_RPC_LATENCY = 15000;
const ELECTION_TIMEOUT = 100000;
const NUM_SERVERS = 7;
const BATCH_SIZE = 1;

const DIRECTIONS = {
  request: 'request',
  reply: 'reply',
};

const SERVER_STATES = {
  follower: 'follower',
  leader: 'leader',
  stopped: 'stopped',
  candidate: 'candidate'
};

const REQUEST_TYPES = {
  requestVote: 'RequestVote',
  appendEntries: 'AppendEntries',
  timeoutMessage: 'TimeoutMessage'
};

(function() {

const rules = {};
pala.rules = rules;

const sendMessage = (model, message) => {
  message.sendTime = model.time;
  message.recvTime = model.time +
        MAX_RPC_LATENCY
  model.messages.push(message);
};

const sendRequest = (model, request) => {
  request.direction = DIRECTIONS.request;
  sendMessage(model, request);
};

const sendReply = (model, request, reply) => {
  model.servers.filter(item => item.id !== request.to).forEach(item => {
    const newReply = {...reply}
    newReply.from = request.to;
    newReply.to = item.id;
    newReply.type = request.type;
    newReply.direction = DIRECTIONS.reply;
    sendMessage(model, newReply);
  })
};

const logTerm = (log, index) => {
  return index < 1 || index > log.length
      ? 0
      : log[index - 1].term;
};

const makeElectionAlarm = (now) => {
  return now +  ELECTION_TIMEOUT;
};

pala.server = (id, peers, isLeader) => {
  return {
    id: id,
    peers: peers,
    state: isLeader ? SERVER_STATES.leader : SERVER_STATES.follower,
    term: 1,
    votedFor: null,
    log: [],
    electionAlarm: isLeader ? 0 : makeElectionAlarm(0),
    voteGranted:  util.makeMap(peers, false),
    matchIndex:   util.makeMap(peers, 0),
    nextIndex:    util.makeMap(peers, 1),
    rpcDue:       util.makeMap(peers, 0),
    heartbeatDue: util.makeMap(peers, 0),
  };
};

const getNewProposerIdxFromServer = (epoch) => epoch % NUM_SERVERS + 1

const stepDown = (model, server, term) => {
  server.term = term;
  server.state = SERVER_STATES.follower;
  server.votedFor = null;
  if (server.electionAlarm <= model.time || server.electionAlarm === util.Inf) {
    server.electionAlarm = makeElectionAlarm(model.time);
  }
};

rules.startNewElection = (model, server) => {
  const isLeaderExist = model.servers.some(item => item.state === SERVER_STATES.leader)
  if ((server.state === SERVER_STATES.follower) &&
      server.electionAlarm <= model.time && !isLeaderExist) {
    clearServers(model, [server])
    server.votedFor = server.id;
    server.state = SERVER_STATES.candidate;
    server.rpcDue =      util.makeMap(server.peers, model.time)
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
      term: server.term,
      lastLogTerm: logTerm(server.log, server.log.length),
      lastLogIndex: server.log.length
    });
  }
};

rules.becomeLeader = (model, server) => {
  const countOfVotes = Object.values(server.voteGranted).reduce((acc, item) => {
    if(item) {
      acc += 1
    }
    return acc
  }, 1)

  if(countOfVotes >= Math.floor(NUM_SERVERS * 2 / 3) && server.state === SERVER_STATES.candidate) {
      const proposerIdx = getNewProposerIdxFromServer(server.term)

      if(server.id === proposerIdx) {
        server.state = SERVER_STATES.leader
        server.nextIndex = util.makeMap(server.peers, server.log.length + 1);
        server.rpcDue       = util.makeMap(server.peers, util.Inf);
        server.heartbeatDue = util.makeMap(server.peers, 0);
        server.electionAlarm = util.Inf;
      }
    clearServers(model, [server])
    server.term += 1
  }
};

const clearServers = (model, servers) => {
  servers.forEach(server => {
        server.votedFor = null
        server.electionAlarm = server.state === SERVER_STATES.leader || server.state === SERVER_STATES.stopped ? 0 : makeElectionAlarm(model.time)
        server.voteGranted =  util.makeMap(server.peers, false)
        server.rpcDue =      util.makeMap(server.peers, model.time + RPC_TIMEOUT)
        server.heartbeatDue = util.makeMap(server.peers, model.time + ELECTION_TIMEOUT / 2)
  })
}

rules.sendAppendEntries = (model, server, peer) => {
  if (server.state === SERVER_STATES.leader &&
      (server.heartbeatDue[peer] <= model.time ||
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
      term: server.term,
      prevIndex: prevIndex,
      prevTerm: logTerm(server.log, prevIndex),
      entries: server.log.slice(prevIndex, lastIndex),
      commitIndex: Math.min(server.commitIndex, lastIndex)
    });
    server.rpcDue[peer] = model.time + RPC_TIMEOUT;
    server.heartbeatDue[peer] = model.time + ELECTION_TIMEOUT / 2;
  }
};

rules.advanceCommitIndex = (model, server) => {
  const matchIndexes = util.mapValues(server.matchIndex).concat(server.log.length);
  matchIndexes.sort(util.numericCompare);
  const n = matchIndexes[Math.floor(NUM_SERVERS / 2)];
  if (server.state === SERVER_STATES.leader &&
      logTerm(server.log, n) === server.term) {
    server.commitIndex = Math.max(server.commitIndex, n);
  }
};

const handleRequestVoteRequest = (model, server, request) => {
  if (server.state === SERVER_STATES.candidate) {
    server.votedFor = request.from;
    server.electionAlarm = makeElectionAlarm(model.time);
    server.peers.forEach(peerId => {
      server.voteGranted[peerId] =
          (server.term === request.term &&
              server.id === request.to &&
          peerId === request.from) || server.voteGranted[peerId];
    })
  }
};

const handleRequestVoteReply = (model, server, reply) => {
  if (server.state === SERVER_STATES.candidate &&
      server.term === reply.term) {
    server.rpcDue[reply.from] = util.Inf;
    server.voteGranted[reply.from] = reply.granted;
  }
};

const handleAppendEntriesRequest = (model, server, request) => {
  let success = false;
  let matchIndex = 0;
  if (server.term < request.term)
    stepDown(model, server, request.term);
  if (server.term === request.term) {
    server.state = SERVER_STATES.follower;
    server.electionAlarm = makeElectionAlarm(model.time);
    if (request.prevIndex === 0 ||
        (request.prevIndex <= server.log.length &&
         logTerm(server.log, request.prevIndex) === request.prevTerm)) {
    success = true;
      let index = request.prevIndex;
      for (let i = 0; i < request.entries.length; i += 1) {
        index += 1;
        if (logTerm(server.log, index) !== request.entries[i].term) {
          while (server.log.length > index - 1)
            server.log.pop();
          server.log.push(request.entries[i]);
        }
      }
      matchIndex = index;
      server.commitIndex = Math.max(server.commitIndex,
                                    request.commitIndex);
    }
  }
  sendReply(model, request, {
    term: server.term,
    success: success,
    matchIndex: matchIndex,
    granted: true
  });
};

const handleAppendEntriesReply = (model, server, reply) => {
  if (server.term < reply.term)
    stepDown(model, server, reply.term);
  if (server.state === SERVER_STATES.leader &&
      server.term === reply.term) {
    if (reply.success) {
      server.matchIndex[reply.from] = Math.max(server.matchIndex[reply.from],
          reply.matchIndex);
    }
    server.nextIndex[reply.from] = reply.success ? reply.matchIndex + 1 : Math.max(1, server.nextIndex[reply.from] - 1);
    server.rpcDue[reply.from] = 0;
  }
};

const handleMessage = (model, server, message) => {
  if (server.state === SERVER_STATES.stopped)
    return;
  if (message.type === REQUEST_TYPES.requestVote) {
    message.direction === DIRECTIONS.request
        ? handleRequestVoteRequest(model, server, message)
        :  handleRequestVoteReply(model, server, message);
    return;
  }
  if (message.type === REQUEST_TYPES.appendEntries) {
    message.direction === DIRECTIONS.request
        ? handleAppendEntriesRequest(model, server, message)
        : handleAppendEntriesReply(model, server, message)
  }
};


pala.update = (model) => {
  model.servers.forEach((server) => {
    rules.startNewElection(model, server);
    rules.becomeLeader(model, server);
    rules.advanceCommitIndex(model, server);
    server.peers.forEach((peer) => {
      rules.sendRequestVote(model, server, peer);
      rules.sendAppendEntries(model, server, peer);
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
  clearServers(model, [server])
  server.state = SERVER_STATES.stopped;
  server.electionAlarm = 0;
};

pala.resume = (model, server) => {
  clearServers(model, [server])
  server.state = SERVER_STATES.follower;
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
    server.log.push({term: server.term,
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
      timers[1] - timers[0] < MAX_RPC_LATENCY) {
    if (timers[0] > model.time + MAX_RPC_LATENCY) {
      model.servers.forEach((server) => {
        if (server.electionAlarm === timers[0]) {
          server.electionAlarm -= MAX_RPC_LATENCY;
          console.log('adjusted S' + server.id + ' timeout forward');
        }
      });
      return;
    }
    model.servers.forEach((server) => {
      if (server.electionAlarm > timers[0] &&
          server.electionAlarm < timers[0] + MAX_RPC_LATENCY) {
        server.electionAlarm += MAX_RPC_LATENCY;
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
  model.servers[1].term = 2;
  model.servers[2].term = 2;
  model.servers[3].term = 2;
  model.servers[4].term = 2;
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
