/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
'use strict';

const raft = {};
const RPC_TIMEOUT = 50000;
const MIN_RPC_LATENCY = 10000;
const MAX_RPC_LATENCY = 15000;
const ELECTION_TIMEOUT = 100000;
const NUM_SERVERS = 5;
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
raft.rules = rules;

const sendMessage = (model, message) => {
  message.sendTime = model.time;
  message.recvTime = model.time +
                     MIN_RPC_LATENCY +
                     Math.random() * (MAX_RPC_LATENCY - MIN_RPC_LATENCY);
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

raft.server = (id, peers, isLeader, leaderIdx) => {
  return {
    id: id,
    peers: peers,
    state: isLeader ? SERVER_STATES.leader : SERVER_STATES.follower,
    term: 1,
    votedFor: null,
    log: [],
    commitIndex: 0,
    nextProposerIdx: leaderIdx + 1,
    electionAlarm: isLeader ? 0 : makeElectionAlarm(0),
    voteGranted:  util.makeMap(peers, false),
    matchIndex:   util.makeMap(peers, 0),
    nextIndex:    util.makeMap(peers, 1),
    rpcDue:       util.makeMap(peers, 0),
    heartbeatDue: util.makeMap(peers, 0),
  };
};

const stepDown = (model, server, term) => {
  server.term = term;
  server.state = SERVER_STATES.follower;
  server.votedFor = null;
  if (server.electionAlarm <= model.time || server.electionAlarm === util.Inf) {
    server.electionAlarm = makeElectionAlarm(model.time);
  }
};

const getNextProposerIdx = (model) => {
  const activeServers = model.servers.filter(item => item.state === SERVER_STATES.follower).sort((a, b) => a - b )
  const nextProposerIdx = model.servers.find(item => item.nextProposerIdx)?.nextProposerIdx
  const findIdxFromActiveServers = activeServers.find(item => item.id === nextProposerIdx)?.id
  const ifServerIdxNotFoundIdx = activeServers.find(item => item.id > nextProposerIdx)
      ? activeServers.find(item => item.id > nextProposerIdx).id
      : activeServers[0].id
  return findIdxFromActiveServers ?? ifServerIdxNotFoundIdx

}

rules.startNewElection = (model, server) => {
  const isLeaderExist = model.servers.some(item => item.state === SERVER_STATES.leader)
  if ((server.state === SERVER_STATES.follower) &&
      server.electionAlarm <= model.time && !isLeaderExist) {
    const proposerIdx = getNextProposerIdx(model)
    server.electionAlarm = proposerIdx === server.id ? 0 : makeElectionAlarm(model.time);
    server.term += 1;
    server.votedFor = server.id;
    server.state = proposerIdx === server.id ? SERVER_STATES.leader : SERVER_STATES.follower;
    server.voteGranted  = util.makeMap(server.peers, false);
    server.matchIndex   = util.makeMap(server.peers, 0);
    server.nextIndex    = util.makeMap(server.peers, 1);
    server.rpcDue       = util.makeMap(server.peers, 0);
    server.heartbeatDue = util.makeMap(server.peers, 0);
    server.nextProposerIdx = proposerIdx === server.id
        ? server.id + 1 > NUM_SERVERS
            ? START_PROPOSER_IDX
            : server.id + 1
        : undefined
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
      lastLogIndex: server.log.length});
  }
};

rules.becomeLeader = (model, server) => {
  if (server.state === SERVER_STATES.candidate &&
      util.countTrue(util.mapValues(server.voteGranted)) + 1 > Math.floor(NUM_SERVERS / 2)) {
    server.state = SERVER_STATES.leader;
    server.nextIndex    = util.makeMap(server.peers, server.log.length + 1);
    server.rpcDue       = util.makeMap(server.peers, util.Inf);
    server.heartbeatDue = util.makeMap(server.peers, 0);
    server.electionAlarm = util.Inf;
  }
};

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
  if (server.term < request.term)
    stepDown(model, server, request.term);
  let granted = false;
  if (server.term === request.term &&
      (server.votedFor === null ||
       server.votedFor === request.from) &&
      (request.lastLogTerm > logTerm(server.log, server.log.length) ||
       (request.lastLogTerm === logTerm(server.log, server.log.length) &&
        request.lastLogIndex >= server.log.length))) {
    granted = true;
    server.votedFor = request.from;
    server.electionAlarm = makeElectionAlarm(model.time);
  }
  sendReply(model, request, {
    term: server.term,
    granted: granted,
  });
};

const handleRequestVoteReply = (model, server, reply) => {
  if (server.term < reply.term)
    stepDown(model, server, reply.term);
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


raft.update = (model) => {
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

raft.stop = (model, server) => {
  server.state = SERVER_STATES.stopped;
  server.electionAlarm = 0;
};

raft.resume = (model, server) => {
  server.state = SERVER_STATES.follower;
  server.electionAlarm = makeElectionAlarm(model.time);
};

raft.resumeAll = (model) => {
  model.servers.forEach((server) => {
    raft.resume(model, server);
  });
};

raft.restart = (model, server) => {
  raft.stop(model, server);
  raft.resume(model, server);
};

raft.drop = (model, message) => {
  model.messages = model.messages.filter((msg) => msg !== message);
};

raft.timeout = (model, server) => {
  server.state = SERVER_STATES.follower;
  server.electionAlarm = 0;
  rules.startNewElection(model, server);
};

raft.clientRequest = (model, server) => {
  if (server.state === SERVER_STATES.leader) {
    server.log.push({term: server.term,
                     value: 'v'});
  }
};

raft.spreadTimers = (model) => {
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

raft.alignTimers = (model) => {
  raft.spreadTimers(model);
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

raft.setupLogReplicationScenario = (model) => {
  const s1 = model.servers[0];
  raft.restart(model, model.servers[1]);
  raft.restart(model, model.servers[2]);
  raft.restart(model, model.servers[3]);
  raft.restart(model, model.servers[4]);
  raft.timeout(model, model.servers[0]);
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
  raft.stop(model, model.servers[2]);
  raft.stop(model, model.servers[3]);
  raft.stop(model, model.servers[4]);
  rules.becomeLeader(model, s1);
  raft.clientRequest(model, s1);
  raft.clientRequest(model, s1);
  raft.clientRequest(model, s1);
};
})();
