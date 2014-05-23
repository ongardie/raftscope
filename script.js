/* jshint esnext: true */
/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global raft */
/* global ELECTION_TIMEOUT */
/* global NUM_SERVERS */
'use strict';

var svg;
var model;
var ARC_WIDTH = 5;
var playback;
var getLeader;
var modelHistory;
var render = {};

$(function() {

let termColors = [
  '#66c2a5',
  '#fc8d62',
  '#8da0cb',
  '#e78ac3',
  '#a6d854',
  '#ffd92f',
];

playback = function() {
  let timeTravel = false;
  let paused = false;
  let pause = function() {
    paused = true;
    $('#time-icon')
      .removeClass('glyphicon-time')
      .addClass('glyphicon-pause');
  };
  let resume = function() {
    if (paused) {
      paused = false;
      let i = util.greatestLower(modelHistory,
                                 function(m) { return m.time > model.time; });
      while (modelHistory.length - 1 > i)
        modelHistory.pop();
      timeTravel = false;
      $('#time-icon')
        .removeClass('glyphicon-pause')
        .addClass('glyphicon-time');
    }
  };
  return {
    pause: pause,
    resume: resume,
    toggle: function() {
      if (paused)
        resume();
      else
        pause();
    },
    isPaused: function() {
      return paused;
    },
    startTimeTravel: function() {
      pause();
      timeTravel = true;
    },
    endTimeTravel: function() {
      if (timeTravel) {
        resume();
        pause();
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

(function() {
  for (let i = 1; i <= NUM_SERVERS; i += 1) {
      let peers = [];
      for (let j = 1; j <= NUM_SERVERS; j += 1) {
        if (i != j)
          peers.push(j);
      }
      model.servers.push(raft.server(i, peers));
  }
})();

svg = $('svg');

let ringSpec = {
  cx: 200,
  cy: 200,
  r: 150,
};

let logsSpec = {
  x: 400,
  y: 50,
  width: 250,
  height: 300,
};


let serverSpec = function(id) {
  let coord = util.circleCoord((id - 1) / NUM_SERVERS,
                               ringSpec.cx, ringSpec.cy, ringSpec.r);
  return {
    cx: coord.x,
    cy: coord.y,
    r: 30,
  };
};

$('#ring', svg).attr(ringSpec);

let serverModal;
let messageModal;

model.servers.forEach(function (server) {
  let s = serverSpec(server.id);
  $('#servers', svg).append(
    $('<g></g>')
      .attr('id', 'server-' + server.id)
      .attr('class', 'server')
      .append($('<a xlink:href="#"></a>')
        .append($('<circle class="background" />')
                   .attr(s))
        .append($('<g class="votes"></g>'))
        .append($('<path />')
                   .attr('style', 'stroke-width: ' + ARC_WIDTH))
        .append($('<text />')
                   .attr({x: s.cx, y: s.cy}))
        ));
  util.reparseSVG($('#servers'));
});

let messageSpec = function(from, to, frac) {
  let fromSpec = serverSpec(from);
  let toSpec = serverSpec(to);
  // adjust frac so you start and end at the edge of servers
  let totalDist  = Math.sqrt(Math.pow(toSpec.cx - fromSpec.cx, 2) +
                             Math.pow(toSpec.cy - fromSpec.cy, 2));
  let travel = totalDist - fromSpec.r - toSpec.r;
  frac = (fromSpec.r / totalDist) + frac * (travel / totalDist);
  return {
    cx: fromSpec.cx + (toSpec.cx - fromSpec.cx) * frac,
    cy: fromSpec.cy + (toSpec.cy - fromSpec.cy) * frac,
    r: 8,
  };
};

let comma = ',';
let arcSpec = function(spec, fraction) {
  let radius = spec.r + ARC_WIDTH/2;
  let end = util.circleCoord(fraction, spec.cx, spec.cy, radius);
  let s = ['M', spec.cx, comma, spec.cy - radius];
  if (fraction > 0.5) {
    s.push('A', radius, comma, radius, '0 0,1', spec.cx, spec.cy + radius);
    s.push('M', spec.cx, comma, spec.cy + radius);
  }
  s.push('A', radius, comma, radius, '0 0,1', end.x, end.y);
  return s.join(' ');
};

let timeSlider;

render.clock = function() {
  if (playback.isTimeTraveling())
    return;
  timeSlider.slider('setAttribute', 'max', model.time);
  timeSlider.slider('setValue', model.time, false);
};

render.servers = function(serversSame) {
  model.servers.forEach(function(server) {
    let serverNode = $('#server-' + server.id, svg);
    serverNode.attr('class', 'server ' + server.state);
    $('path', serverNode)
      .attr('d', arcSpec(serverSpec(server.id),
         util.clamp((server.electionAlarm - model.time) /
                    (ELECTION_TIMEOUT * 2),
                    0, 1)));
    if (!serversSame) {
      $('circle.background', serverNode)
        .attr('style', 'fill: ' +
              (server.state == 'stopped'
                ? 'gray'
                : termColors[server.term % termColors.length]));
      let votesGroup = $('.votes', serverNode);
      votesGroup.empty();
      if (server.state == 'candidate') {
        model.servers.forEach(function (peer) {
          let coord = util.circleCoord((peer.id - 1) / NUM_SERVERS,
                                       serverSpec(server.id).cx,
                                       serverSpec(server.id).cy,
                                       serverSpec(server.id).r * 5/8);
          let state;
          if (peer == server || server.voteGranted[peer.id]) {
            state = 'have';
          } else if (peer.votedFor == server.id && peer.term == server.term) {
            state = 'coming';
          } else {
            state = 'no';
          }
          let granted = (peer == server
                           ? true
                           : server.voteGranted[peer.id]);
          votesGroup.append(
            $('<circle />')
              .attr({
                cx: coord.x,
                cy: coord.y,
                r: 5,
              })
              .attr('class', state));
        });
        util.reparseSVG(votesGroup);
      }
      $('text', serverNode).text(server.term);
      serverNode
        .unbind('click')
        .click(function() {
          serverModal(model, server);
          return false;
        });
    }
  });
};

render.entry = function(spec, entry, committed) {
  return $('<g></g>')
    .attr('class', 'entry ' + (committed ? 'committed' : 'uncommitted'))
    .append($('<rect />')
      .attr(spec)
      .attr('stroke-dasharray', committed ? '1 0' : '5 5')
      .attr('style', 'fill: ' + termColors[entry.term % termColors.length]))
    .append($('<text />')
      .attr({x: spec.x + spec.width / 2,
             y: spec.y + spec.height / 2})
      .text(entry.term));
};

render.logs = function() {
  let logsGroup = $('#logsGroup', svg);
  logsGroup.empty();
  logsGroup.append(
    $('<rect />')
      .attr('id', 'logs')
      .attr(logsSpec));
  let height = logsSpec.height / NUM_SERVERS;
  let leader = getLeader();
  model.servers.forEach(function(server) {
    let logSpec = {
      x: logsSpec.x + logsSpec.width * 0.05,
      y: logsSpec.y + height * server.id - 5*height/6,
      width: logsSpec.width * 0.9,
      height: 2*height/3,
    };
    logsGroup.append(
      $('<rect />')
        .attr(logSpec)
        .attr('class', 'log'));
    server.log.forEach(function(entry, i) {
      let index = i + 1;
        logsGroup.append(render.entry({
          x: logSpec.x + i * 25,
          y: logSpec.y,
          width: 25,
          height: logSpec.height,
        }, entry, index <= server.commitIndex));
    });
    if (leader !== null && leader != server) {
      logsGroup.append(
        $('<circle />')
          .attr({cx: logSpec.x + leader.matchIndex[server.id] * 25,
                 cy: logSpec.y + logSpec.height,
                 r: 5}));
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
  let messagesGroup = $('#messages', svg);
  if (!messagesSame) {
    messagesGroup.empty();
    model.messages.forEach(function(message, i) {
      messagesGroup.append(
        $('<a xlink:href="#"></a>')
          .attr('id', 'message-' + i)
          .attr('class', 'message ' + message.direction + ' ' + message.type)
          .append($('<circle />'))
          .append($('<path />')));
    });
    util.reparseSVG(messagesGroup);
    model.messages.forEach(function(message, i) {
      $('a#message-' + i, svg)
        .click(function() {
          messageModal(model, message);
          return false;
        });
    });
  }
  model.messages.forEach(function(message, i) {
    let s = messageSpec(message.from, message.to,
                        (model.time - message.sendTime) /
                        (message.recvTime - message.sendTime));
    $('#message-' + i + ' circle', messagesGroup)
      .attr(s);
    if (message.direction == 'reply') {
      let dlist = [];
      dlist.push('M', s.cx - s.r, comma, s.cy,
                 'L', s.cx + s.r, comma, s.cy);
      if ((message.type == 'RequestVote' && message.granted) ||
          (message.type == 'AppendEntries' && message.success)) {
         dlist.push('M', s.cx, comma, s.cy - s.r,
                    'L', s.cx, comma, s.cy + s.r);
      }
      $('#message-' + i + ' path', messagesGroup)
        .attr('d', dlist.join(' '));
    }
  });
};

let relTime = function(time, now) {
  if (time == Infinity)
    return 'infinity';
  let sign = time > now ? '+' : '';
  return sign + ((time - now) / 1e3).toFixed(3) + 'ms';
};

let button = function(label) {
  return $('<button type="button" class="btn btn-default"></button>')
    .text(label);
};

serverModal = function(model, server) {
  let m = $('#modal-details');
  $('.modal-title', m).text('Server ' + server.id);
  let li = function(label, value) {
    return '<dt>' + label + '</dt><dd>' + value + '</dd>';
  };
  let peerTable = $('<table></table>')
    .addClass('table table-condensed')
    .append($('<tr></tr>')
      .append('<th>peer</th>')
      .append('<th>next index</th>')
      .append('<th>match index</th>')
      .append('<th>vote granted</th>')
      .append('<th>RPC due</th>')
      .append('<th>heartbeat due</th>')
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
      .append(li('electionAlarm', relTime(server.electionAlarm, model.time)))
      .append($('<dt>peers</dt>'))
      .append($('<dd></dd>').append(peerTable))
    );
  $('.modal-footer', m)
    .empty()
    .append(button('stop')
      .click(function(){
        raft.stop(model, server);
        render.update();
        m.modal('hide');
      }))
    .append(button('resume')
      .click(function(){
        raft.resume(model, server);
        render.update();
        m.modal('hide');
      }))
    .append(button('restart')
      .click(function(){
        raft.stop(model, server);
        raft.resume(model, server);
        render.update();
        m.modal('hide');
      }));
  m.modal();
};

messageModal = function(model, message) {
  let m = $('#modal-details');
  $('.modal-title', m).text(message.type + ' ' + message.direction);
  let li = function(label, value) {
    return '<dt>' + label + '</dt><dd>' + value + '</dd>';
  };
  let fields = $('<dl class="dl-horizontal"></dl>')
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
      let entries = '[' + message.entries.map(function(e) {
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
  $('.modal-footer', m)
    .empty()
    .append(button('drop')
      .click(function(){
        raft.drop(model, message);
        render.update();
        m.modal('hide');
      }));
  m.modal();
};

render.update = function() {
  raft.update(model);

  let last = modelHistory[modelHistory.length - 1];
  let serversSame = util.equals(last.servers, model.servers);
  let messagesSame = util.equals(last.messages, model.messages);
  if (playback.isTimeTraveling()) {
    serversSame = false;
    messagesSame = false;
  } else {
    if (!serversSame || !messagesSame)
      modelHistory.push(util.clone(model));
  }
  render.clock();
  render.servers(serversSame);
  render.messages(messagesSame);
  if (!serversSame)
    render.logs();
};


let sliderTransform = function(v) {
  v = Math.pow(v, 3) + 100;
  if (v < 1)
    return 1;
  else if (v > 1000)
    return 1000;
  else
    return v;
};

window.setInterval(function() {
  if (playback.isPaused())
    return;
  model.time += 10 * 1000 / sliderTransform($('#speed').slider('getValue'));
  render.update();
}, 10);

$(window).keyup(function(e) {
  if (e.keyCode == ' '.charCodeAt(0)) {
    playback.toggle();
  } else if (e.keyCode == 'C'.charCodeAt(0)) {
    let leader = getLeader();
    if (leader !== null) {
      playback.endTimeTravel();
      leader.log.push({term: leader.term,
                       value: 'keypress'});
      render.update();
    }
  } else if (e.keyCode == 'R'.charCodeAt(0)) {
    let leader = getLeader();
    if (leader !== null) {
      playback.endTimeTravel();
      raft.stop(model, leader);
      raft.resume(model, leader);
      render.update();
    }
  }
});

$('#modal-details').on('show.bs.modal', function(e) {
  playback.pause();
});

getLeader = function() {
  let leader = null;
  let term = 0;
  model.servers.forEach(function(server) {
    if (server.state == 'leader' &&
        server.term > term) {
        leader = server;
        term = server.term;
    }
  });
  return leader;
};

$("#speed").slider({
  tooltip: 'always',
  formater: function(value) {
    return sliderTransform(value).toFixed(0) + 'x';
  },
  reversed: true,
});

timeSlider = $('#time');
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
  let t = timeSlider.slider('getValue');
  let i = util.greatestLower(modelHistory, function(m) { return m.time > t; });
  model = util.clone(modelHistory[i]);
  model.time = t;
  render.update();
});

$('#time-button')
  .click(function() {
    playback.toggle();
    return false;
  });

modelHistory = [util.clone(model)];
model.servers[0].electionAlarm = 10;
modelHistory.push(util.clone(model));
});

