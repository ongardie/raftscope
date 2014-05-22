'use strict';

var svg;
var model;
var NUM_SERVERS = 5;
var RPC_TIMEOUT = 50000;
var RPC_LATENCY = 10000;
var ELECTION_TIMEOUT = 100000;
var ARC_WIDTH = 5;
var BATCH_SIZE = 1;
var rules = {};
var playback;
var getLeader;
var history;
var update;
var render = {};

var util = {};

$(function() {

var makeElectionAlarm = function(model) {
  return model.time + (Math.random() + 1) * ELECTION_TIMEOUT;
};

playback = function() {
  var timeTravel = false;
  var paused = false;
  var resume = function() {
    if (paused) {
      paused = false;
      var i = util.greatestLower(history, function(m) { return m.time > model.time; });
      while (history.length - 1 > i)
        history.pop();
      timeTravel = false;
    }
  };
  return {
    pause: function() {
      paused = true;
    },
    resume: resume,
    toggle: function() {
      if (paused)
        resume();
      else
        paused = true;
    },
    isPaused: function() {
      return paused;
    },
    startTimeTravel: function() {
      paused = true;
      timeTravel = true;
    },
    endTimeTravel: function() {
      if (timeTravel) {
        resume();
        paused = true;
      }
    },
    isTimeTraveling: function() {
      return timeTravel;
    },
  };
}();

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
      while (entries.length > index)
        entries.pop();
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
    voteGranted:  util.makeMap(peers, false),
    matchIndex:   util.makeMap(peers, 0),
    nextIndex:    util.makeMap(peers, 1),
    rpcDue:       util.makeMap(peers, 0),
    heartbeatDue: util.makeMap(peers, 0),
  };
};

rules.startNewElection = function(model, server) {
  if ((server.state == 'follower' || server.state == 'candidate') &&
      server.electionAlarm < model.time) {
    server.electionAlarm = makeElectionAlarm(model);
    server.term += 1;
    server.votedFor = server.id;
    server.state = 'candidate';
    server.voteGranted  = util.makeMap(server.peers, false);
    server.matchIndex   = util.makeMap(server.peers, 0);
    server.nextIndex    = util.makeMap(server.peers, 1);
    server.rpcDue       = util.makeMap(server.peers, 0);
    server.heartbeatDue = util.makeMap(server.peers, 0);
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
    server.nextIndex    = util.makeMap(server.peers, server.log.len() + 1);
    server.rpcDue       = util.makeMap(server.peers, Infinity);
    server.heartbeatDue = util.makeMap(server.peers, 0);
    server.electionAlarm = Infinity;
  }
};

rules.sendAppendEntries = function(model, server, peer) {
  if (server.state == 'leader' &&
      (server.heartbeatDue[peer] < model.time ||
       (server.nextIndex[peer] <= server.log.len() &&
        server.rpcDue[peer] < model.time))) {
    var prevIndex = server.nextIndex[peer] - 1;
    var lastIndex = Math.min(prevIndex + BATCH_SIZE,
                             server.log.len());
    if (server.matchIndex[peer] + 1 < server.nextIndex[peer])
      lastIndex = prevIndex;
    sendRequest(model, {
      from: server.id,
      to: peer,
      type: 'AppendEntries',
      term: server.term,
      prevIndex: prevIndex,
      prevTerm: server.log.term(prevIndex),
      entries: server.log.slice(prevIndex + 1, lastIndex + 1),
      commitIndex: Math.min(server.commitIndex, lastIndex)});
    server.rpcDue[peer] = model.time + RPC_TIMEOUT;
    server.heartbeatDue[peer] = model.time + ELECTION_TIMEOUT / 2;
  }
};

rules.advanceCommitIndex = function(model, server) {
  var matchIndexes = util.mapValues(server.matchIndex).concat(server.log.len());
  matchIndexes.sort();
  var n = matchIndexes[Math.floor(NUM_SERVERS / 2)];
  if (server.state == 'leader' &&
      server.log.term(n) == server.term) {
    server.commitIndex = Math.max(server.commitIndex, n);
  }
}

var stepDown = function(model, server, term) {
  server.term = term;
  server.state = 'follower';
  server.votedFor = null;
  if (server.electionAlarm < model.time || server.electionAlarm == Infinity) {
    server.electionAlarm = makeElectionAlarm(model);
  }
};

var sendMessage = function(model, message) {
  message.sendTime = model.time;
  message.recvTime = model.time + (1 + (.5 * (Math.random() - .5))) * RPC_LATENCY;
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
    stepDown(model, server, reply.term);
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
      var index = request.prevIndex;
      for (var i = 0; i < request.entries.length; i += 1) {
        index += 1;
        if (server.log.term(index) != request.entries[i].term) {
          server.log.truncatePast(index - 1);
          server.log.append(request.entries[i]);
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

var handleAppendEntriesReply = function(model, server, reply) {
  if (server.term < reply.term)
    stepDown(model, server, reply.term);
  if (server.state == 'leader' &&
      server.term == reply.term) {
    if (reply.success) {
      server.matchIndex[reply.from] = Math.max(server.matchIndex[reply.from],
                                               reply.matchIndex);
      server.nextIndex[reply.from] = reply.matchIndex + 1;
    } else {
      server.nextIndex[reply.from] = Math.max(1, server.nextIndex[reply.from] - 1);
    }
    server.rpcDue[reply.from] = 0;
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
  cx: 200,
  cy: 200,
  r: 150,
};

var logsSpec = {
  x: 400,
  y: 50,
  width: 250,
  height: 300,
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

util.reparseSVG = function(node) {
  node.html(node.html()); // reparse as SVG after adding nodes
};

$('#ring', svg).attr(ringSpec);

model.servers.forEach(function (server) {
  var s = serverSpec(server.id);
  $('#servers', svg).append(
    $('<g></g>')
      .attr('id', 'server-' + server.id)
      .attr('class', 'server')
      .append($('<a xlink:href="#"></a>')
        .append($('<circle />')
                   .attr(s))
        .append($('<path />')
                   .attr('style', 'stroke-width: ' + ARC_WIDTH))
        .append($('<text />')
                   .attr({x: s.cx, y: s.cy}))
        ));
  util.reparseSVG($('#servers'));
  model.servers.forEach(function(server) {
    $('#server-' + server.id + ' a', svg)
      .click(function() {
        serverModal(server);
        return false;
      });
  });
});

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
  var s = ['M', spec.cx, comma, spec.cy - radius];
  if (fraction > .5) {
    s.push('A', radius, comma, radius, '0 0,1', spec.cx, spec.cy + radius);
    s.push('M', spec.cx, comma, spec.cy + radius);
  }
  s.push('A', radius, comma, radius, '0 0,1', end.x, end.y);
  return s.join(' ');
};

render.clock = function() {
  if (playback.isTimeTraveling())
    return;
  timeSlider.slider('setAttribute', 'max', model.time);
  timeSlider.slider('setValue', model.time, false);
};

render.servers = function() {
  model.servers.forEach(function(server) {
    var serverNode = $('#server-' + server.id, svg);
    $('circle', serverNode)
      .attr('class', server.state);
    $('path', serverNode)
      .attr('d', arcSpec(serverSpec(server.id),
              Math.min(1, (server.electionAlarm - model.time) /
                          (ELECTION_TIMEOUT * 2))));
    $('text', serverNode).text(server.term);
  });
};

render.entry = function(spec, entry, committed) {
  return $('<g></g>')
    .attr('class', 'entry')
    .append($('<rect />')
      .attr(spec)
      .attr('stroke-dasharray', committed ? '1 0' : '5 5'))
    .append($('<text />')
      .attr({x: spec.x + spec.width / 2,
             y: spec.y + spec.height / 2})
      .text(entry.term));
};

render.logs = function() {
  var logsGroup = $('#logsGroup', svg);
  logsGroup.empty();
  logsGroup.append(
    $('<rect />')
      .attr('id', 'logs')
      .attr(logsSpec));
  var height = logsSpec.height / NUM_SERVERS;
  var leader = getLeader();
  model.servers.forEach(function(server) {
    var logSpec = {
      x: logsSpec.x + logsSpec.width * .05,
      y: logsSpec.y + height * server.id - 5*height/6,
      width: logsSpec.width * .9,
      height: 2*height/3,
    };
    logsGroup.append(
      $('<rect />')
        .attr(logSpec)
        .attr('class', 'log'));
    server.log.entries.forEach(function(entry, i) {
      var index = i + 1;
        logsGroup.append(render.entry({
          x: logSpec.x + i * 25,
          y: logSpec.y,
          width: 25,
          height: logSpec.height,
        }, entry, index <= server.commitIndex));
    });
    if (leader != null && leader != server) {
      logsGroup.append(
        $('<circle />')
          .attr({cx: logSpec.x + leader.matchIndex[server.id] * 25,
                 cy: logSpec.y + logSpec.height,
                 r: 3}));
      logsGroup.append($('<rect />')
        .attr('class', 'nextIndex')
        .attr({
          x: logSpec.x + (leader.nextIndex[server.id] - 1) * 25,
          y: logSpec.y,
          width: 25,
          height: logSpec.height,
        }));
    }
  });
  util.reparseSVG(logsGroup);
};

render.messages = function(messagesSame) {
  var messagesGroup = $('#messages', svg);
  if (messagesSame) {
    model.messages.forEach(function(message, i) {
      var s = messageSpec(message.from, message.to,
                          (model.time - message.sendTime) /
                          (message.recvTime - message.sendTime));
      $('#message-' + i + ' circle', messagesGroup)
        .attr(s);
    });
  } else {
    messagesGroup.empty();
    model.messages.forEach(function(message, i) {
      var s = messageSpec(message.from, message.to,
                          (model.time - message.sendTime) /
                          (message.recvTime - message.sendTime));
      messagesGroup.append(
        $('<a xlink:href="#"></a>')
          .attr('id', 'message-' + i)
          .append($('<circle />')
            .attr('class', 'message ' + message.direction)
            .attr(s)));
    });
    util.reparseSVG(messagesGroup);
    model.messages.forEach(function(message, i) {
      $('a#message-' + i, svg)
        .click(function() {
          messageModal(message);
          return false;
        });
    });
  }
};

var relTime = function(time, now) {
  if (time == Infinity)
    return 'infinity';
  var sign = time > now ? '+' : '';
  return sign + ((time - now) / 1e3).toFixed(3) + 'ms';
}

var serverModal = function(server) {
  var m = $('#modal-details');
  $('.modal-title', m).text('Server ' + server.id);
  var li = function(label, value) {
    return '<dt>' + label + '</dt><dd>' + value + '</dd>';
  };
  var peerTable = $('<table></table>')
    .addClass('table')
    .append($('<tr></tr>')
      .append('<th>peer</th>')
      .append('<th>nextIndex</th>')
      .append('<th>matchIndex</th>')
      .append('<th>voteGranted</th>')
      .append('<th>rpcDue</th>')
      .append('<th>heartbeatDue</th>')
    );
  server.peers.forEach(function(peer) {
    peerTable.append($('<tr></tr>')
      .append('<td>S' + peer + '</td>')
      .append('<td>' + server.nextIndex[peer] + '</td>')
      .append('<td>' + server.matchIndex[peer] + '</td>')
      .append('<td>' + server.voteGranted[peer] + '</td>')
      .append('<td>' + relTime(server.rpcDue[peer], model.time) + '</td>')
      .append('<td>' + relTime(server.heartbeatDue[peer], model.time) + '</td>')
    );
  });
  $('.modal-body', m)
    .empty()
    .append($('<dl class="dl-horizontal"></dl>')
      .append(li('state', server.state))
      .append(li('currentTerm', server.term))
      .append(li('votedFor', server.votedFor))
      .append(li('commitIndex', server.commitIndex))
      .append($('<dt>peers</dt>'))
      .append($('<dd></dd>').append(peerTable))
    );
  m.modal();
};

var messageModal = function(message) {
  var m = $('#modal-details');
  $('.modal-title', m).text(message.type + ' ' + message.direction);
  var li = function(label, value) {
    return '<dt>' + label + '</dt><dd>' + value + '</dd>';
  };
  var fields = $('<dl class="dl-horizontal"></dl>')
      .append(li('from', 'S' + message.from))
      .append(li('to', 'S' + message.to))
      .append(li('sent', relTime(message.sendTime, model.time)))
      .append(li('deliver', relTime(message.recvTime, model.time)))
      .append(li('term', message.term));
  if (message.type == 'RequestVote') {
    if (message.direction == 'request') {
      fields.append(li('lastLogIndex', message.lastLogIndex));
      fields.append(li('lastLogTerm', message.lastLogTerm));
    } else {
      fields.append(li('granted', message.granted));
    }
  } else if (message.type == 'AppendEntries') {
    if (message.direction == 'request') {
      var entries = '[' + message.entries.map(function(e) {
            return e.term;
      }).join(' ') + ']';
      fields.append(li('prevIndex', message.prevIndex));
      fields.append(li('prevTerm', message.prevTerm));
      fields.append(li('entries', entries));
      fields.append(li('commitIndex', message.commitIndex));
    } else {
      fields.append(li('success', message.success));
      fields.append(li('matchIndex', message.matchIndex));
    }
  }
  $('.modal-body', m)
    .empty()
    .append(fields);
  m.modal();
};

util.clone = function(object) {
  return jQuery.extend(true, {}, object);
};

// From http://stackoverflow.com/a/6713782
util.equals = function(x, y) {
  if ( x === y ) return true;
    // if both x and y are null or undefined and exactly the same

  if ( ! ( x instanceof Object ) || ! ( y instanceof Object ) ) return false;
    // if they are not strictly equal, they both need to be Objects

  if ( x.constructor !== y.constructor ) return false;
    // they must have the exact same prototype chain, the closest we can do is
    // test there constructor.

  for ( var p in x ) {
    if ( ! x.hasOwnProperty( p ) ) continue;
      // other properties were tested using x.constructor === y.constructor

    if ( ! y.hasOwnProperty( p ) ) return false;
      // allows to compare x[ p ] and y[ p ] when set to undefined

    if ( x[ p ] === y[ p ] ) continue;
      // if they have the same strict value or identity then they are equal

    if ( typeof( x[ p ] ) !== "object" ) return false;
      // Numbers, Strings, Functions, Booleans must be strictly equal

    if ( ! util.equals( x[ p ],  y[ p ] ) ) return false;
      // Objects and Arrays must be tested recursively
  }

  for ( p in y ) {
    if ( y.hasOwnProperty( p ) && ! x.hasOwnProperty( p ) ) return false;
      // allows x[ p ] to be set to undefined
  }
  return true;
};

var update = function() {
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

  var last = history[history.length - 1];
  var serversSame = util.equals(last.servers, model.servers);
  var messagesSame = util.equals(last.messages, model.messages);
  if (playback.isTimeTraveling()) {
    serversSame = false;
    messagesSame = false;
  } else {
    if (!serversSame || !messagesSame)
      history.push(util.clone(model));
  }
  render.clock();
  render.servers();
  render.messages(messagesSame);
  if (!serversSame)
    render.logs();
};

setInterval(function() {
  if (playback.isPaused())
    return;
  model.time += 10 * 1000 / sliderTransform($('#speed').slider('getValue'));
  update();
}, 10);

$(window).keyup(function(e) {
  if (e.keyCode == ' '.charCodeAt(0)) {
    playback.toggle();
  } else if (e.keyCode == 'C'.charCodeAt(0)) {
    var leader = getLeader();
    if (leader != null) {
      playback.endTimeTravel();
      leader.log.append({term: leader.term,
                         value: 'keypress'});
      update();
    }
  } else if (e.keyCode == 'R'.charCodeAt(0)) {
    var leader = getLeader();
    if (leader != null) {
      playback.endTimeTravel();
      stepDown(model, leader, leader.term);
      update();
    }
  }
});

$('#modal-details').on('show.bs.modal', function(e) {
  playback.pause();
});

getLeader = function() {
  var leader = null;
  var term = 0;
  model.servers.forEach(function(server) {
    if (server.state == 'leader' &&
        server.term > term) {
        leader = server;
        term = server.term;
    }
  });
  return leader;
};

var sliderTransform = function(v) {
  v = Math.pow(v, 3) + 100;
  if (v < 1)
    return 1;
  else if (v > 1000)
    return 1000;
  else
    return v;
}

$("#speed").slider({
  tooltip: 'always',
  formater: function(value) {
    return sliderTransform(value).toFixed(0) + 'x';
  },
  reversed: true,
});

util.greatestLower = function(a, gt) {
  var bs = function(low, high) {
    if (high < low)
      return low - 1;
    var mid = Math.floor((low + high) / 2);
    if (gt(a[mid]))
      return bs(low, mid - 1);
    else
      return bs(mid + 1, high);
  };
  return bs(0, a.length - 1);
}

var timeSlider = $('#time');
timeSlider.slider({
  tooltip: 'always',
  formater: function(value) {
    return (value / 1e6).toFixed(3) + 's';
  },
});
timeSlider.on('slideStart', function() {
  playback.startTimeTravel();
});
timeSlider.on('slide', function() {
  var t = timeSlider.slider('getValue');
  var i = util.greatestLower(history, function(m) { return m.time > t; });
  model = util.clone(history[i]);
  model.time = t;
  update();
});

history = [util.clone(model)];
model.servers[0].electionAlarm = 10;
history.push(util.clone(model));
});

