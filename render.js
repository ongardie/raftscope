/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global ELECTION_TIMEOUT */
/* global raft */
/* global state */
/* global util */
'use strict';

var render = {};
var graphics = {};
var speedSlider;
var playback;


var DISPLAY_INITIAL_LE = 10,
    DISPLAY_MIN_EMPTY_LE = 1,
    DISPLAY_LE_EXTEND = 5,
    DISPLAY_LE_CURRENT = 0;

$(function () {

    var sliding = false;

// -----------------------------------------------------------------------------
// Functions that render servers, messages and the log table
// -----------------------------------------------------------------------------


    var comma = ',';
    var svg = $('svg');
    var SVG = function (tag) {
        return $(document.createElementNS('http://www.w3.org/2000/svg', tag));
    };

    var MESSAGE_RADIUS = 8;
    var ARC_WIDTH = 5;

    var ringSpec = {
        cx: 210,
        cy: 210,
        r: 150,
    };

    $('#pause').attr('transform',
        'translate(' + ringSpec.cx + ', ' + ringSpec.cy + ') ' +
        'scale(' + ringSpec.r / 3.5 + ')');

    var serverSpec = function (server_id, nservers) {
        nservers = nservers !== undefined ? nservers : state.current.servers.length;

        var pos = raft.getServerIndexById(state.current, server_id);
        var coord = util.circleCoord(pos / nservers,
            ringSpec.cx, ringSpec.cy, ringSpec.r);
        return {
            cx: coord.x,
            cy: coord.y,
            r: 30,
        };
    };

    $('#ring', svg).attr(ringSpec);

    var messageSpec = function (from, to, frac) {
        var fromSpec = serverSpec(from);
        var toSpec = serverSpec(to);
        // adjust frac so you start and end at the edge of servers
        var totalDist = Math.sqrt(Math.pow(toSpec.cx - fromSpec.cx, 2) +
            Math.pow(toSpec.cy - fromSpec.cy, 2));
        var travel = totalDist - fromSpec.r - toSpec.r;
        frac = (fromSpec.r / totalDist) + frac * (travel / totalDist);
        return {
            cx: fromSpec.cx + (toSpec.cx - fromSpec.cx) * frac,
            cy: fromSpec.cy + (toSpec.cy - fromSpec.cy) * frac,
            r: MESSAGE_RADIUS,
        };
    };

    var messageArrowSpec = function (from, to, frac) {
        var fromSpec = serverSpec(from);
        var toSpec = serverSpec(to);
        // adjust frac so you start and end at the edge of servers
        var totalDist = Math.sqrt(Math.pow(toSpec.cx - fromSpec.cx, 2) +
            Math.pow(toSpec.cy - fromSpec.cy, 2));
        var travel = totalDist - fromSpec.r - toSpec.r;
        var fracS = ((fromSpec.r + MESSAGE_RADIUS) / totalDist) +
            frac * (travel / totalDist);
        var fracH = ((fromSpec.r + 2 * MESSAGE_RADIUS) / totalDist) +
            frac * (travel / totalDist);
        return [
            'M', fromSpec.cx + (toSpec.cx - fromSpec.cx) * fracS, comma,
            fromSpec.cy + (toSpec.cy - fromSpec.cy) * fracS,
            'L', fromSpec.cx + (toSpec.cx - fromSpec.cx) * fracH, comma,
            fromSpec.cy + (toSpec.cy - fromSpec.cy) * fracH,
        ].join(' ');
    };

    var arcSpec = function (spec, fraction) {
        var radius = spec.r + ARC_WIDTH / 2;
        var end = util.circleCoord(fraction, spec.cx, spec.cy, radius);
        var s = ['M', spec.cx, comma, spec.cy - radius];
        if (fraction > 0.5) {
            s.push('A', radius, comma, radius, '0 0,1', spec.cx, spec.cy + radius);
            s.push('M', spec.cx, comma, spec.cy + radius);
        }
        s.push('A', radius, comma, radius, '0 0,1', end.x, end.y);
        return s.join(' ');
    };

    graphics.get_creator = function (tot_srv) {
        return function (server, idx) {
            var s = serverSpec(server.id, tot_srv);
            $('#servers', svg).append(
                SVG('g')
                    .attr('id', 'server-' + server.id)
                    .attr('class', 'server')
                    .append(SVG('text')
                        .attr('class', 'serverid')
                        .text('S' + server.id)
                        .attr(util.circleCoord(idx / tot_srv,
                            ringSpec.cx, ringSpec.cy, ringSpec.r + 50)))
                    .append(SVG('a')
                        .append(SVG('circle')
                            .attr('class', 'background')
                            .attr(s))
                        .append(SVG('g')
                            .attr('class', 'votes'))
                        .append(SVG('path')
                            .attr('style', 'stroke-width: ' + ARC_WIDTH))
                        .append(SVG('text')
                            .attr('class', 'term')
                            .attr({x: s.cx, y: s.cy}))
                    ));
        };
    };

    graphics.realign = function (tot_srv) {
        return function (server, idx) {
            var s = serverSpec(server.id, tot_srv);
            $('#server-' + server.id + ' .serverid').attr(
                util.circleCoord(idx / tot_srv,
                    ringSpec.cx, ringSpec.cy, ringSpec.r + 50));
            $('#server-' + server.id + ' a .term').attr({x: s.cx, y: s.cy});
            $('#server-' + server.id + ' a circle').attr({cx: s.cx, cy: s.cy});
        };
    };

    render.servers = function (serversSame) {
        state.current.servers.forEach(function (server) {
            var serverNode = $('#server-' + server.id, svg);
            $('path', serverNode)
                .attr('d', arcSpec(serverSpec(server.id),
                    util.clamp((server.electionAlarm - state.current.time) /
                        (ELECTION_TIMEOUT * 2),
                        0, 1)));
            if (!serversSame) {
                $('text.term', serverNode).text(server.term);
                serverNode.attr('class', 'server ' + server.state);
                $('circle.background', serverNode)
                    .removeClass (function (index, css) {
                        return (css.match (/(^|\s)color-\S+/g) || []).join(' ');
                    }).addClass(
                        server.state === 'stopped'?
                            'color-stopped' : 'color-' + server.term % 10);
                var votesGroup = $('.votes', serverNode);
                votesGroup.empty();
                if (server.state == 'candidate') {
                    state.current.servers.forEach(function (peer) {
                        //var coord = util.circleCoord((peer.id - 1) / this,
                        var coord = util.circleCoord(raft.getServerIndexById(this.model, peer.id) / this.nsrv,
                            serverSpec(server.id).cx,
                            serverSpec(server.id).cy,
                            serverSpec(server.id).r * 5 / 8);
                        var state;
                        if (peer == server || server.voteGranted[peer.id]) {
                            state = 'have';
                        } else if (peer.votedFor == server.id && peer.term == server.term) {
                            state = 'coming';
                        } else {
                            state = 'no';
                        }
                        votesGroup.append(
                            SVG('circle')
                                .attr({
                                    cx: coord.x,
                                    cy: coord.y,
                                    r: 5,
                                })
                                .attr('class', state));
                    }, {model: state.current, nsrv: state.current.servers.length});
                }
                serverNode
                    .unbind('click')
                    .click(function () {
                        serverModal(state.current, server);
                        return false;
                    });
                if (serverNode.data('context'))
                    serverNode.data('context').destroy();
                serverNode.contextmenu({
                    target: '#context-menu',
                    before: function () {
                        var closemenu = this.closemenu.bind(this);
                        var list = $('ul', this.getMenu());
                        list.empty();
                        serverActions.forEach(function (action) {
                            list.append($('<li></li>')
                                .append($('<a href="#"></a>')
                                    .text(action[0])
                                    .click(function () {
                                        state.fork();
                                        action[1](state.current, server);
                                        state.save();
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

    render.messages = function (messagesSame) {
        var messagesGroup = $('#messages', svg);
        if (!messagesSame) {
            messagesGroup.empty();
            state.current.messages.forEach(function (message, i) {
                var a = SVG('a')
                    .attr('id', 'message-' + i)
                    .attr('class', 'message ' + message.direction + ' ' + message.type)
                    .attr('title', message.type + ' ' + message.direction)//.tooltip({container: 'body'})
                    .append(SVG('circle'))
                    .append(SVG('path').attr('class', 'message-direction'));
                if (message.direction == 'reply')
                    a.append(SVG('path').attr('class', 'message-success'));
                messagesGroup.append(a);
            });
            state.current.messages.forEach(function (message, i) {
                var messageNode = $('a#message-' + i, svg);
                messageNode
                    .click(function () {
                        messageModal(state.current, message);
                        return false;
                    });
                if (messageNode.data('context'))
                    messageNode.data('context').destroy();
                messageNode.contextmenu({
                    target: '#context-menu',
                    before: function () {
                        var closemenu = this.closemenu.bind(this);
                        var list = $('ul', this.getMenu());
                        list.empty();
                        messageActions.forEach(function (action) {
                            list.append($('<li></li>')
                                .append($('<a href="#"></a>')
                                    .text(action[0])
                                    .click(function () {
                                        state.fork();
                                        action[1](state.current, message);
                                        state.save();
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
        state.current.messages.forEach(function (message, i) {
            var s = messageSpec(message.from, message.to,
                (state.current.time - message.sendTime) /
                (message.recvTime - message.sendTime));
            $('#message-' + i + ' circle', messagesGroup).attr(s);
            if (message.direction == 'reply') {
                var dlist = [];
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
            var dir = $('#message-' + i + ' path.message-direction', messagesGroup);
            if (playback.isPaused()) {
                dir.attr('style', 'marker-end:url(#TriangleOutS-' + message.type + ')')
                    .attr('d',
                        messageArrowSpec(message.from, message.to,
                            (state.current.time - message.sendTime) /
                            (message.recvTime - message.sendTime)));
            } else {
                dir.attr('style', '').attr('d', 'M 0,0'); // clear
            }
        });
    };

    render.logsTable = function (model) {
        var max_log_len = Math.max.apply(null,
            model.servers.map(function(server) {return server.log.length;})),
            req_log_len = Math.max(DISPLAY_LE_CURRENT, DISPLAY_INITIAL_LE, max_log_len + DISPLAY_MIN_EMPTY_LE),
            scroll = false;

        if (req_log_len > DISPLAY_LE_CURRENT) {
            DISPLAY_LE_CURRENT += DISPLAY_LE_EXTEND;
            scroll = true;
        }


        var cnt = $("#log-div");
        cnt.html([
            '<table id="log-table"><thead><tr>',
            (function(){
                var buff = ['<th>Servers</th>'];
                for (var i=1; i <= DISPLAY_LE_CURRENT; i++)
                    buff.push('<th>' + i + '</th>');
                return buff.join('');
            })(),
            '</tr></thead><tbody>',
            (function(){
                var buff = [];
                Array.prototype.push.apply(
                    buff,
                    model.servers.map(function(server){
                        var line = ['<tr><td id="cell-', server.id, '-0">S',
                            server.id, '</td>'];
                        for (var array_id=0; array_id < DISPLAY_LE_CURRENT; array_id++) {
                            var log_id = array_id+1;
                            Array.prototype.push.apply(line,
                                    ['<td id="cell-', server.id, '-', log_id, '" ']);
                            if (array_id < server.log.length) {
                                Array.prototype.push.apply(line, [
                                    'class="',
                                    (log_id <= server.commitIndex? '': 'un') + 'committed ',
                                    'color-', server.log[array_id].term % 10,
                                    server.log[array_id].isConfig ? ' config' :  '',
                                    server.log[array_id].isNoop? ' noop' :  '',
                                ]);
                            }
                            Array.prototype.push.apply(line, [
                                '">',
                                (array_id >= server.log.length ? '' : (
                                    server.log[array_id].term +
                                    (!server.log[array_id].isConfig ? '': (
                                        'C<sub>' +
                                        (server.log[array_id].isAdd ? '+' : '-') +
                                        'S' + server.log[array_id].value +
                                        '</sub>'
                                    ))
                                )),
                                '</td>',
                            ]);
                        }
                        return line.join('');
                    })
                );
                return buff.join('');
            })(),
            '</tbody></table>'
        ].join(''));

        var leader = raft.getLeader(model);
        if (leader !== null) $('#cell-' + leader.id + '-0').addClass('leader');
        model.servers.forEach(function(server) {
            if (leader !== null && leader != server) {
                $('#cell-' + server.id + '-' + leader.matchIndex[server.id])
                    .addClass('matchIndex');
                $('#cell-' + server.id + '-' + leader.nextIndex[server.id])
                    .addClass('nextIndex');
            }
        });

        if (scroll) cnt.scrollLeft(cnt.width());
    };

    render.pendingTable = function(model) {
        $('#pending-queue').html(
            model.pendingConf
                .map(function(entry) {
                    return [
                        '<td class="',
                        entry.isAdd ? 'add' : 'rm',
                        '">',
                        entry.value,
                        '</td>',
                    ];
                })
                .reduce(function(prev, curr){return prev.concat(curr);}, [])
                .join('') +
            '<td></td>'
        );
    };



// -----------------------------------------------------------------------------
// Renders new state
// -----------------------------------------------------------------------------

    var lastRenderedO = null;
    var lastRenderedV = null;

    render.update = function () {
        var serversSame = false;
        var messagesSame = false;
        // Same indicates both underlying object identity hasn't changed and its
        // value hasn't changed.
        if (lastRenderedO == state.current) {
            serversSame = util.equals(lastRenderedV.servers, state.current.servers);
            messagesSame = util.equals(lastRenderedV.messages, state.current.messages);
        }
        lastRenderedO = state;
        lastRenderedV = state.base();
        render.updateTimeSlider();
        render.updateNoiseSlider();
        render.servers(serversSame);
        render.messages(messagesSame);
        if (!serversSame)
            render.logsTable(state.current);
        render.pendingTable(state.current);
    };

// -----------------------------------------------------------------------------
// Slider and button setup
// -----------------------------------------------------------------------------

    playback = function () {
        var paused = false;
        var pause = function () {
            paused = true;
            $('#time-icon')
                .removeClass('glyphicon-time')
                .addClass('glyphicon-pause');
            $('#pause').attr('class', 'paused');
            render.update();
        };
        var resume = function () {
            if (paused) {
                paused = false;
                $('#time-icon')
                    .removeClass('glyphicon-pause')
                    .addClass('glyphicon-time');
                $('#pause').attr('class', 'resumed');
                render.update();
            }
        };
        return {
            pause: pause,
            resume: resume,
            toggle: function () {
                if (paused)
                    resume();
                else
                    pause();
            },
            isPaused: function () {
                return paused;
            },
        };
    }();

    $('#time-button').click(function () {
        playback.toggle();
        return false;
    });

    speedSlider = $('#speed');
    speedSlider.slider({
        tooltip: 'always',
        formatter: function (value) {
            return '1/' + util.speedSliderTransform(value).toFixed(0) + 'x';
        },
        reversed: true,
    });

    var timeSlider = $('#time');
    timeSlider.slider({
        tooltip: 'always',
        formatter: function (value) {
            return (value / 1e6).toFixed(3) + 's';
        },
    });
    timeSlider.on('slideStart', function () {
        playback.pause();
        sliding = true;
    });
    timeSlider.on('slideStop', function () {
        // If you click rather than drag,  there won't be any slide events, so you
        // have to seek and update here too.
        state.seek(timeSlider.slider('getValue'));
        sliding = false;
        render.update();
    });
    timeSlider.on('slide', function () {
        state.seek(timeSlider.slider('getValue'));
        render.update();
    });

    render.updateTimeSlider = function () {
        // Used to update the time slider at every tick
        if (!sliding) {
            timeSlider.slider('setAttribute', 'max', state.getMaxTime());
            timeSlider.slider('setValue', state.current.time, false);
        }
    };

    render.updateNoiseSlider = function () {
        if (!settingNoise){
            noiseSlider.slider('setValue', state.current.channelNoise, false);
        }
    };
    var settingNoise = false;
    var noiseSlider = $('#channel-noise');
    noiseSlider.slider({
        tooltip: 'always',
        formatter: function (value) {
            return (value * 100).toFixed(1) + '%';
        }
    });
    noiseSlider.on('slideStart', function () {
        settingNoise = true;
    });
    noiseSlider.on("slideStop", function () {
        state.fork();
        settingNoise = false;
        state.current.channelNoise = noiseSlider.slider('getValue');
        state.save();
        render.update();
    });

    $("#add-server").click(function () {
        state.fork();
        raft.addServer(state.current);
        state.save();
        render.update();
        return true;
    });

// -----------------------------------------------------------------------------
// On click modal menus
// -----------------------------------------------------------------------------

    // Pauses simulation on modal click
    $('#modal-details').on('show.bs.modal', function () {
        playback.pause();
    });

    var serverActions = [
        ['stop', raft.stop],
        ['resume', raft.resume],
        ['restart', raft.restart],
        ['time out', raft.timeout],
        ['request', raft.clientRequest],
        ['remove', raft.removeServer],
    ];

    var messageActions = [
        ['drop', raft.drop],
    ];

    var serverModal = function (model, server) {
        var m = $('#modal-details');
        $('.modal-title', m).text('Server ' + server.id);
        $('.modal-dialog', m).removeClass('modal-sm').addClass('modal-lg');
        var li = function (label, value) {
            return '<dt>' + label + '</dt><dd>' + value + '</dd>';
        };
        $('.modal-body', m)
            .empty()
            .append($('<dl class="dl-horizontal"></dl>')
                .append(li('state', server.state))
                .append(li('currentTerm', server.term))
                .append(li('votedFor', server.votedFor))
                .append(li('commitIndex', server.commitIndex))
                .append(li('electionAlarm', util.relativeTime(server.electionAlarm, model.time)))
            );
        var isLeader = server.state === 'leader';
        if (isLeader || server.state === "candidate") {
            var tableHeader = $('<tr></tr>');
            var peerTable = $('<table></table>');
            peerTable.addClass('table table-condensed');
            tableHeader.append('<th>peer</th>');
            if (isLeader)
                tableHeader
                    .append('<th>next index</th>')
                    .append('<th>match index</th>');
            tableHeader
                .append('<th>vote granted</th>')
                .append('<th>RPC due</th>');
            if (isLeader) tableHeader.append('<th>heartbeat due</th>');
            peerTable.append(tableHeader);
            server.peers.forEach(function (peer) {
                var tableRow = $('<tr></tr>');
                tableRow.append('<td>S' + peer + '</td>')
                if (isLeader)
                    tableRow
                        .append('<td>' + server.nextIndex[peer] + '</td>')
                        .append('<td>' + server.matchIndex[peer] + '</td>');
                tableRow
                    .append('<td>' + server.voteGranted[peer] + '</td>')
                    //  Dirty hack to replace negative timers from being displayed in rpcDue
                    .append('<td>' + util.relativeTime(server.rpcDue[peer] === 0 ? util.Inf : server.rpcDue[peer], model.time) + '</td>');
                if (isLeader) tableRow.append('<td>' + util.relativeTime(server.heartbeatDue[peer], model.time) + '</td>');
                peerTable.append(tableRow);
            });
            $('.modal-body dl', m)
                .append($('<dt>peers</dt>'))
                .append($('<dd></dd>').append(peerTable));
        }
        var footer = $('.modal-footer', m);
        footer.empty();
        serverActions.filter(function (action) {
            return server.state == "leader" || action[0] !== "request";
        }).forEach(function (action) {
            footer.append(util.getButton(action[0])
                .click(function () {
                    state.fork();
                    // action[1] == callback
                    action[1](model, server);
                    state.save();
                    render.update();
                    m.modal('hide');
                }));
        });
        m.modal();
    };

    var messageModal = function (model, message) {
        var m = $('#modal-details');
        $('.modal-dialog', m).removeClass('modal-lg').addClass('modal-sm');
        $('.modal-title', m).text(message.type + ' ' + message.direction);
        var li = function (label, value) {
            return '<dt>' + label + '</dt><dd>' + value + '</dd>';
        };
        var fields = $('<dl class="dl-horizontal"></dl>')
            .append(li('from', 'S' + message.from))
            .append(li('to', 'S' + message.to))
            .append(li('sent', util.relativeTime(message.sendTime, model.time)))
            .append(li('deliver', util.relativeTime(message.recvTime, model.time)))
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
                var entries = '[' + message.entries.map(function (e) {
                        return '(' + e.term + (e.isConfig ? ( ',' + (e.isAdd ? '+':'-') +'S'+ e.value) : '') + ')';
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
        var footer = $('.modal-footer', m);
        footer.empty();
        messageActions.forEach(function (action) {
            footer.append(util.getButton(action[0])
                .click(function () {
                    state.fork();
                    action[1](model, message);
                    state.save();
                    render.update();
                    m.modal('hide');
                }));
        });
        m.modal();
    };
});
