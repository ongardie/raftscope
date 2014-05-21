var svg;
var model;
var NUM_SERVERS = 5;
var RPC_TIMEOUT = 50000;
var RPC_LATENCY = 10000;
var ELECTION_TIMEOUT = 100000;
var ARC_WIDTH = 5;
var renderMessages;
var rules = {};

var util = {};

$(function() {

var makeElectionAlarm = function(model) {
  return model.time + (Math.random() + 1) * ELECTION_TIMEOUT;
};

model = {
  servers: [],
  messages: [],
  time: 0,
  seed: 0,
};

var makeLog = function() {
  var entries = [];
  return {
    entries: entries,
    at: function(index) {
      return entries[index - 1];
    },
    len: function() {
      return entries.length;
    },
    term: function(index) {
      if (index < 1 || index > entries.length) {
        return 0;
      } else {
        return entries[index - 1].term;
      }
    },
    slice: function(startIndexIncl, endIndexExcl) {
      return entries.slice(startIndexIncl - 1, endIndexExcl - 1);
    },
    append: function(entry) {
      entries.push(entry);
    },
    truncatePast: function(index) {
      entries = entries.slice(0, index);
    },
  };
};

util.value = function(v) {
  return function() { return v; };
};

util.circleCoord = function(frac, cx, cy, r) {
  var radians = 2 * Math.PI * (.75 + frac);
  return {
    x: cx + r * Math.cos(radians),
    y: cy + r * Math.sin(radians),
  };
};

util.countTrue = function(bools) {
  var count = 0;
  bools.forEach(function(b) {
    if (b)
      count += 1;
  });
  return count;
};

util.makeMap = function(keys, value) {
  var m = {};
  keys.forEach(function(key) {
    m[key] = value;
  });
  return m;
};

util.mapValues = function(m) {
  return $.map(m, function(v) { return v; });
};

var Server = function(id, peers) {
  return {
    id: id,
    peers: peers,
    state: 'follower',
    term: 1,
    votedFor: null,
    log: makeLog(),
    commitIndex: 0,
    electionAlarm: makeElectionAlarm(model),
    rpcDue:      util.makeMap(peers, 0),
    voteGranted: util.makeMap(peers, false),
    matchIndex:  util.makeMap(peers, 0),
    nextIndex:   util.makeMap(peers, 1),
  };
};

rules.startNewElection = function(model, server) {
  if ((server.state == 'follower' || server.state == 'candidate') &&
      server.electionAlarm < model.time) {
    server.electionAlarm = makeElectionAlarm(model);
    server.term += 1;
    server.votedFor = server.id;
    server.state = 'candidate';
    server.rpcDue      = util.makeMap(server.peers, 0);
    server.voteGranted = util.makeMap(server.peers, false);
    server.matchIndex  = util.makeMap(server.peers, 0);
    server.nextIndex   = util.makeMap(server.peers, 1);
  }
};

rules.sendRequestVote = function(model, server, peer) {
  if (server.state == 'candidate' &&
      server.rpcDue[peer] < model.time) {
    server.rpcDue[peer] = model.time + RPC_TIMEOUT;
    sendRequest(model, {
      from: server.id,
      to: peer,
      type: 'RequestVote',
      term: server.term,
      lastLogTerm: server.log.term(server.log.len()),
      lastLogIndex: server.log.len()});
  }
};

rules.becomeLeader = function(model, server) {
  if (server.state == 'candidate' &&
      util.countTrue(util.mapValues(server.voteGranted)) + 1 > Math.floor(NUM_SERVERS / 2)) {
    console.log('server ' + server.id + ' is leader in term ' + server.term);
    server.state = 'leader';
    server.nextIndex = util.makeMap(server.peers, server.log.len() + 1);
    server.rpcDue    = util.makeMap(server.peers, model.time);
    server.electionAlarm = Infinity;
  }
};

rules.sendAppendEntries = function(model, server, peer) {
  if (server.state == 'leader' &&
      (server.nextIndex[peer] < server.log.len() ||
       server.rpcDue[peer] < model.time)) {
    server.rpcDue[peer] = model.time + ELECTION_TIMEOUT / 2;
    var lastIndex = server.nextIndex[peer];
    if (lastIndex > server.log.len())
      lastIndex -= 1;
    server.nextIndex[peer] = lastIndex;
    sendRequest(model, {
      from: server.id,
      to: peer,
      type: 'AppendEntries',
      term: server.term,
      prevIndex: server.nextIndex[peer] - 1,
      prevTerm: server.log.term(server.nextIndex[peer] - 1),
      entries: server.log.slice(server.nextIndex[peer], lastIndex + 1),
      commitIndex: Math.min(server.commitIndex, lastIndex)});
  }
};

rules.advanceCommitIndex = function(model, server) {
  var matchIndexes = util.mapValues(server.matchIndex).concat(server.log.len());
  matchIndexes.sort();
  var n = matchIndexes[Math.floor(NUM_SERVERS / 2)];
  if (server.state == 'leader' &&
      server.log.term(n) == server.term) {
    server.commitIndex = n;
  }
}

var stepDown = function(model, server, term) {
  server.term = term;
  server.state = 'follower';
  server.votedFor = null;
  if (server.electionAlarm < model.time) {
    server.electionAlarm = makeElectionAlarm(model);
  }
};

var sendMessage = function(model, message) {
  message.sendTime = model.time;
  message.recvTime = model.time + RPC_LATENCY;
  model.messages.push(message);
};

var sendRequest = function(model, request) {
  request.direction = 'request';
  sendMessage(model, request);
};

var sendReply = function(model, request, reply) {
  reply.from = request.to;
  reply.to = request.from;
  reply.type = request.type;
  reply.direction = 'reply';
  sendMessage(model, reply);
};

var handleRequestVoteRequest = function(model, server, request) {
  if (server.term < request.term)
    stepDown(model, server, request.term);
  var granted = false;
  if (server.term == request.term &&
      (server.votedFor == null ||
       server.votedFor == request.from) &&
      (request.lastLogTerm > server.log.term(server.log.len()) ||
       (request.lastLogTerm == server.log.term(server.log.len()) &&
        request.lastLogIndex >= server.log.len()))) {
    granted = true;
    server.votedFor = request.from;
    server.electionAlarm = makeElectionAlarm(model);
  }
  sendReply(model, request, {
    term: server.term,
    granted: granted,
  });
};

var handleRequestVoteReply = function(model, server, reply) {
  if (server.term < reply.term)
    stepDown(reply.term);
  if (server.state == 'candidate' &&
      server.term == reply.term) {
    server.rpcDue[reply.from] = Infinity;
    server.voteGranted[reply.from] = reply.granted;
  }
}

var handleAppendEntriesRequest = function(model, server, request) {
  var success = false;
  var matchIndex = 0;
  if (server.term < request.term)
    stepDown(model, server, request.term);
  if (server.term == request.term) {
    server.state = 'follower';
    server.electionAlarm = makeElectionAlarm(model);
    if (request.prevLogIndex == 0 ||
        (request.prevIndex <= server.log.len() &&
         server.log.term(request.prevIndex) == request.prevTerm)) {
      success = true;
      var index = 0;
      for (var i = 0; i < request.entries.length; i += 1) {
        index = request.prevIndex + 1 + i;
        if (server.log.term(index) != request.entries[i].term) {
          server.log.truncatePast(index - 1);
          server.log.append(request.entries[i]);
        }
      }
      matchIndex = index;
      server.commitIndex = request.commitIndex;
    }
  }
  sendReply(model, request, {
    term: server.term,
    success: success,
    matchIndex: matchIndex,
  });
};

var handleAppendEntriesReply = function(model, server, reply) {
  if (server.term < reply.term)
    stepDown(reply.term);
  if (server.state == 'leader' &&
      server.term == reply.term) {
    if (reply.successs) {
      server.matchIndex[reply.from] = reply.matchIndex;
      server.nextIndex[reply.from] += 1;
    } else {
      server.nextIndex[reply.from] = Math.max(1, server.nextIndex[reply.from] - 1);
    }
  }
}

var handleMessage = function(model, server, message) {
  if (message.type == 'RequestVote') {
    if (message.direction == 'request')
      handleRequestVoteRequest(model, server, message);
    else
      handleRequestVoteReply(model, server, message);
  } else if (message.type == 'AppendEntries') {
    if (message.direction == 'request')
      handleAppendEntriesRequest(model, server, message);
    else
      handleAppendEntriesReply(model, server, message);
  }
};

(function() {
  for (var i = 1; i <= NUM_SERVERS; i += 1) {
      var peers = [];
      for (var j = 1; j <= NUM_SERVERS; j += 1) {
        if (i != j)
          peers.push(j);
      }
      model.servers.push(Server(i, peers));
  }
})();

svg = $('svg');

var ringSpec = {
  cx: 300,
  cy: 200,
  r: 150,
};

var serverSpec = function(id) {
  var coord = util.circleCoord((id - 1) / NUM_SERVERS,
                               ringSpec.cx, ringSpec.cy, ringSpec.r);
  return {
    cx: coord.x,
    cy: coord.y,
    r: 30,
  };
};

var ring = svg.append(
  $('<circle />')
    .attr('id', 'ring')
    .attr(ringSpec));

model.servers.forEach(function (server) {
  var s = serverSpec(server.id);
  svg.append(
    $('<g></g>')
      .attr('id', 'server-' + server.id)
      .attr('class', 'server')
      .append($('<circle />')
                 .attr(s))
      .append($('<path />')
                 .attr('style', 'stroke-width: ' + ARC_WIDTH)));
});

util.reparseSVG = function() {
  svg.html(svg.html()); // reparse as SVG after adding nodes
};
util.reparseSVG();

var messageSpec = function(from, to, frac) {
  var fromSpec = serverSpec(from);
  var toSpec = serverSpec(to);
  // adjust frac so you start and end at the edge of servers
  var totalDist  = Math.sqrt(Math.pow(toSpec.cx - fromSpec.cx, 2) +
                             Math.pow(toSpec.cy - fromSpec.cy, 2));
  var travel = totalDist - fromSpec.r - toSpec.r;
  frac = (fromSpec.r / totalDist) + frac * (travel / totalDist);
  return {
    cx: fromSpec.cx + (toSpec.cx - fromSpec.cx) * frac,
    cy: fromSpec.cy + (toSpec.cy - fromSpec.cy) * frac,
    r: 5,
  };
};

var arcSpec = function(spec, fraction) {
  var comma = ',';
  var radius = spec.r + ARC_WIDTH/2;
  var end = util.circleCoord(fraction, spec.cx, spec.cy, radius);
  s = ['M', spec.cx, comma, spec.cy - radius];
  if (fraction > .5) {
    s.push('A', radius, comma, radius, '0 0,1', spec.cx, spec.cy + radius);
    s.push('M', spec.cx, comma, spec.cy + radius);
  }
  s.push('A', radius, comma, radius, '0 0,1', end.x, end.y);
  return s.join(' ');
};

renderServers = function() {
  model.servers.forEach(function(server) {
    var serverNode = $('#server-' + server.id, svg);
    $('circle', serverNode)
      .attr('class', server.state);
    $('path', serverNode)
      .attr('d', arcSpec(serverSpec(server.id),
              Math.min(1, (server.electionAlarm - model.time) /
                          (ELECTION_TIMEOUT * 2))));
  });
};

renderMessages = function() {
  $('.message', svg).remove();
  model.messages.forEach(function(message) {
    var s = messageSpec(message.from, message.to,
                        (model.time - message.sendTime) /
                        (message.recvTime - message.sendTime));
    if (message.recvTime >= model.time) {
      svg.append(
        $('<circle />')
          .addClass('message')
          .attr(s));
    }
  });
  util.reparseSVG();
};

setInterval(function() {
  model.time += 100;
  model.servers.forEach(function(server) {
    rules.startNewElection(model, server);
    rules.becomeLeader(model, server);
    rules.advanceCommitIndex(model, server);
    server.peers.forEach(function(peer) {
      rules.sendRequestVote(model, server, peer);
      rules.sendAppendEntries(model, server, peer);
    });
  });
  var deliver = [];
  var keep = [];
  model.messages.forEach(function(message) {
    if (message.recvTime <= model.time)
      deliver.push(message);
    else
      keep.push(message);
  });
  model.messages = keep;
  deliver.forEach(function(message) {
    model.servers.forEach(function(server) {
      if (server.id == message.to) {
        handleMessage(model, server, message);
      }
    });
  });


  renderServers();
  renderMessages();
}, 10);



});
