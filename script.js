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
    render.update();
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
      render.update();
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
  cy: 210,
  r: 150,
};

let logsSpec = {
  x: 410,
  y: 50,
  width: 275,
  height: 270,
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
      .append($('<text class="serverid" />')
                 .text('S' + server.id)
                 .attr(util.circleCoord((server.id - 1) / NUM_SERVERS,
                                        ringSpec.cx, ringSpec.cy, ringSpec.r + 45)))
      .append($('<a xlink:href="#"></a>')
        .append($('<circle class="background" />')
                   .attr(s))
        .append($('<g class="votes"></g>'))
        .append($('<path />')
                   .attr('style', 'stroke-width: ' + ARC_WIDTH))
        .append($('<text class="term" />')
                   .attr({x: s.cx, y: s.cy}))
        ));
});
util.reparseSVG($('#servers'));

let MESSAGE_RADIUS = 8;

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
    r: MESSAGE_RADIUS,
  };
};

let messageArrowSpec = function(from, to, frac) {
  let fromSpec = serverSpec(from);
  let toSpec = serverSpec(to);
  // adjust frac so you start and end at the edge of servers
  let totalDist  = Math.sqrt(Math.pow(toSpec.cx - fromSpec.cx, 2) +
                             Math.pow(toSpec.cy - fromSpec.cy, 2));
  let travel = totalDist - fromSpec.r - toSpec.r;
  let fracS = ((fromSpec.r + MESSAGE_RADIUS)/ totalDist) +
               frac * (travel / totalDist);
  let fracH = ((fromSpec.r + 2*MESSAGE_RADIUS)/ totalDist) +
               frac * (travel / totalDist);
  return [
    'M', fromSpec.cx + (toSpec.cx - fromSpec.cx) * fracS, comma,
         fromSpec.cy + (toSpec.cy - fromSpec.cy) * fracS,
    'L', fromSpec.cx + (toSpec.cx - fromSpec.cx) * fracH, comma,
         fromSpec.cy + (toSpec.cy - fromSpec.cy) * fracH,
  ].join(' ');
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

let serverActions = [
  ['stop', raft.stop],
  ['resume', raft.resume],
  ['restart', raft.restart],
  ['time out', raft.timeout],
  ['request', raft.clientRequest],
];

let messageActions = [
  ['drop', raft.drop],
];

render.servers = function(serversSame) {
  model.servers.forEach(function(server) {
    let serverNode = $('#server-' + server.id, svg);
    serverNode.attr('class', 'server ' + server.state);
    $('path', serverNode)
      .attr('d', arcSpec(serverSpec(server.id),
         util.clamp((server.electionAlarm - model.time) /
                    (ELECTION_TIMEOUT * 2),
                    0, 1)));
    $('text.term', serverNode).text(server.term);
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
      serverNode
        .unbind('click')
        .click(function() {
          serverModal(model, server);
          return false;
        });
      if (serverNode.data('context'))
        serverNode.data('context').destroy();
      serverNode.contextmenu({
        target: '#context-menu',
        before: function(e) {
          let closemenu = this.closemenu.bind(this);
          let list = $('ul', this.getMenu());
          list.empty();
          serverActions.forEach(function(action) {
            list.append($('<li></li>')
              .append($('<a href="#"></a>')
                .text(action[0])
                .click(function() {
                  action[1](model, server);
                  render.update();
                  closemenu();
                  return false;
                })));
          });
          return true;
        },
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
  let LABEL_WIDTH = 20;
  let INDEX_HEIGHT = 25;
  let logsGroup = $('#logsGroup', svg);
  logsGroup.empty();
  logsGroup.append(
    $('<rect />')
      .attr('id', 'logs')
      .attr(logsSpec));
  let height = (logsSpec.height - INDEX_HEIGHT) / NUM_SERVERS;
  let leader = getLeader();
  let indexSpec = {
    x: logsSpec.x + LABEL_WIDTH + logsSpec.width * 0.05,
    y: logsSpec.y + 2*height/6,
    width: logsSpec.width * 0.9,
    height: 2*height/3,
  };
  for (let index = 1; index <= 10; ++index) {
    let indexEntrySpec = {
      x: indexSpec.x + (index - 0.5) * indexSpec.width / 11,
      y: indexSpec.y,
      width: indexSpec.width / 11,
      height: indexSpec.height,
    };
    logsGroup
        .append($('<text />')
          .attr(indexEntrySpec)
          .text(index));
  }
  model.servers.forEach(function(server) {
    let logSpec = {
      x: logsSpec.x + LABEL_WIDTH + logsSpec.width * 0.05,
      y: logsSpec.y + INDEX_HEIGHT + height * server.id - 5*height/6,
      width: logsSpec.width * 0.9,
      height: 2*height/3,
    };
    let logEntrySpec = function(index) {
      return {
        x: logSpec.x + (index - 1) * logSpec.width / 11,
        y: logSpec.y,
        width: logSpec.width / 11,
        height: logSpec.height,
      };
    };
    logsGroup.append(
        $('<text />')
          .text('S' + server.id)
          .attr({x: logSpec.x - LABEL_WIDTH*4/5,
                 y: logSpec.y + logSpec.height / 2}));
    for (let index = 1; index <= 10; ++index) {
      logsGroup
        .append($('<rect />')
          .attr(logEntrySpec(index))
          .attr('class', 'log'))
    }
    server.log.forEach(function(entry, i) {
      let index = i + 1;
        logsGroup.append(render.entry(
             logEntrySpec(index),
             entry,
             index <= server.commitIndex));
    });
    if (leader !== null && leader != server) {
      logsGroup.append(
        $('<circle />')
          .attr({cx: logEntrySpec(leader.matchIndex[server.id] + 1).x,
                 cy: logSpec.y + logSpec.height,
                 r: 5}));
      var x = logEntrySpec(leader.nextIndex[server.id] + 0.5).x;
      logsGroup.append($('<path />')
        .attr('style', 'marker-end:url(#TriangleOutM); stroke: black')
        .attr('d', ['M', x, comma, logSpec.y + logSpec.height + logSpec.height/3,
                    'L', x, comma, logSpec.y + logSpec.height + logSpec.height/6].join(' '))
        .attr('stroke-width', 3));
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
          .append($('<path class="message-success" />'))
          .append($('<path class="message-direction" />')));
    });
    util.reparseSVG(messagesGroup);
    model.messages.forEach(function(message, i) {
      let messageNode = $('a#message-' + i, svg);
      messageNode
        .click(function() {
          messageModal(model, message);
          return false;
        });
      if (messageNode.data('context'))
        messageNode.data('context').destroy();
      messageNode.contextmenu({
        target: '#context-menu',
        before: function(e) {
          let closemenu = this.closemenu.bind(this);
          let list = $('ul', this.getMenu());
          list.empty();
          messageActions.forEach(function(action) {
            list.append($('<li></li>')
              .append($('<a href="#"></a>')
                .text(action[0])
                .click(function() {
                  action[1](model, message);
                  render.update();
                  closemenu();
                  return true;
                })));
          });
          return true;
        },
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
      $('#message-' + i + ' path.message-success', messagesGroup)
        .attr('d', dlist.join(' '));
    }
    let dir = $('#message-' + i + ' path.message-direction', messagesGroup);
    if (playback.isPaused()) {
      dir.attr('style', 'marker-end:url(#TriangleOutS-' + message.type + ')')
         .attr('d',
           messageArrowSpec(message.from, message.to,
                            (model.time - message.sendTime) /
                            (message.recvTime - message.sendTime)));
    } else {
      dir.attr('style', '').attr('d', 'M 0,0'); // clear
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
  $('.modal-dialog', m).removeClass('modal-sm').addClass('modal-lg');
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
  let footer = $('.modal-footer', m);
  footer.empty();
  serverActions.forEach(function(action) {
    footer.append(button(action[0])
      .click(function(){
        action[1](model, server);
        render.update();
        m.modal('hide');
      }));
  });
  m.modal();
};

messageModal = function(model, message) {
  let m = $('#modal-details');
  $('.modal-dialog', m).removeClass('modal-lg').addClass('modal-sm');
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
  let footer = $('.modal-footer', m);
  footer.empty();
  messageActions.forEach(function(action) {
    footer.append(button(action[0])
      .click(function(){
        action[1](model, message);
        render.update();
        m.modal('hide');
      }));
  });
  m.modal();
};

render.update = function() {
  raft.update(model);

  let last = modelHistory[modelHistory.length - 1];
  let serversSame = util.equals(last.servers, model.servers);
  let messagesSame = util.equals(last.messages, model.messages);
  if (model.time == 0 || playback.isTimeTraveling()) {
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
      raft.clientRequest(model, leader);
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
  } else if (e.keyCode == 'T'.charCodeAt(0)) {
    playback.endTimeTravel();
    raft.spreadTimers(model);
    render.update();
  } else if (e.keyCode == 'A'.charCodeAt(0)) {
    playback.endTimeTravel();
    raft.alignTimers(model);
    render.update();
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
render.update();
});

