/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global graphics */
/* global INITIAL_SERVER_NUMBER */
'use strict';

var raft = {};
var RPC_TIMEOUT = 50000;
var MIN_RPC_LATENCY = 10000;
var MAX_RPC_LATENCY = 15000;
var ELECTION_TIMEOUT = 100000;
var BATCH_SIZE = 1;
var NEXT_SERVER_ID = 1;

(function () {

    var sendMessage = function (model, message) {
        message.sendTime = model.time;
        message.recvTime = model.time +
            MIN_RPC_LATENCY +
            Math.random() * (MAX_RPC_LATENCY - MIN_RPC_LATENCY);
        if (Math.random() < model.channelNoise) {
            message.dropTime = (message.recvTime - message.sendTime) * util.randomBetween(1 / 3, 3 / 4) + message.sendTime;
        }
        model.messages.push(message);
    };

    var sendRequest = function (model, request) {
        request.direction = 'request';
        sendMessage(model, request);
    };

    var sendReply = function (model, request, reply) {
        reply.from = request.to;
        reply.to = request.from;
        reply.type = request.type;
        reply.direction = 'reply';
        sendMessage(model, reply);
    };

    var logTerm = function (log, index) {
        if (index < 1 || index > log.length) {
            return 0;
        } else {
            return log[index - 1].term;
        }
    };

    var rules = {};
    raft.rules = rules;

    var makeElectionAlarm = function (now) {
        return now + (Math.random() + 1) * ELECTION_TIMEOUT;
    };

    raft.getIdAndIncrement = function() {
        return NEXT_SERVER_ID++;
    };

    raft.getServerIndexById = function (model, id) {
        return model.servers.findIndex(function(srv){return srv.id === id;});
    };

    raft.server = function (model, my_id) {
        var peers = [];
        for (var i=1; i <= INITIAL_SERVER_NUMBER; i++)
            if (i != my_id)
                peers.push(i);

        return {
            id: my_id,
            peers: peers,
            state: 'follower',
            term: 1,
            votedFor: null,
            log: [],
            commitIndex: 0,
            configIndex: 0,
            electionAlarm: makeElectionAlarm(model.time),
            // Section 4.2.3
            // Negative value does not impede first round of votes.
            lastHeartbeat: - ELECTION_TIMEOUT,
        };
    };


    var stepDown = function (model, server, term) {
        server.term = term;
        server.state = 'follower';
        server.votedFor = null;
        if (server.electionAlarm <= model.time || server.electionAlarm == util.Inf) {
            server.electionAlarm = makeElectionAlarm(model.time);
        }
        server.lastHeartbeat = 0;
    };

    rules.startNewElection = function (model, server) {
        if ((server.state == 'follower' || server.state == 'candidate') &&
            server.electionAlarm <= model.time) {
            server.electionAlarm = makeElectionAlarm(model.time);
            server.term += 1;
            server.votedFor = server.id;
            server.state = 'candidate';
            server.voteGranted = util.makeMap(server.peers, false);
            server.rpcDue = util.makeMap(server.peers, false);
        }
    };

    rules.sendRequestVote = function (model, server, peer) {
        if (server.state == 'candidate' &&
            server.rpcDue[peer] <= model.time) {
            server.rpcDue[peer] = model.time + RPC_TIMEOUT;
            sendRequest(model, {
                from: server.id,
                to: peer,
                type: 'RequestVote',
                term: server.term,
                lastLogTerm: logTerm(server.log, server.log.length),
                lastLogIndex: server.log.length
            });
        }
    };

    rules.becomeLeader = function (model, server) {
        if (server.state == 'candidate' &&
            util.countTrue(util.mapValues(server.voteGranted)) + 1 >= Math.floor((server.peers.length + 1) / 2) + 1) {
            server.state = 'leader';

            // Build stats table
            server.matchIndex = util.makeMap(server.peers, 0);
            server.nextIndex = util.makeMap(server.peers, server.log.length + 1);
            server.rpcDue = util.makeMap(server.peers, util.Inf);
            server.heartbeatDue = util.makeMap(server.peers, 0);
            server.electionAlarm = util.Inf;
            server.log.push({
                term: server.term,
                isNoop: true,
            });
            model.pendingConf = [];
        }
    };

    rules.sendAppendEntries = function (model, server, peer) {
        if (server.state == 'leader' &&
            (server.heartbeatDue[peer] <= model.time ||
            (server.nextIndex[peer] <= server.log.length &&
            server.rpcDue[peer] <= model.time))) {
            var prevIndex = server.nextIndex[peer] - 1;
            var lastIndex = Math.min(prevIndex + BATCH_SIZE,
                server.log.length);
            if (server.matchIndex[peer] + 1 < server.nextIndex[peer])
                lastIndex = prevIndex;
            var data = server.log.slice(prevIndex, lastIndex);
            sendRequest(model, {
                from: server.id,
                to: peer,
                type: 'AppendEntries',
                term: server.term,
                prevIndex: prevIndex,
                prevTerm: logTerm(server.log, prevIndex),
                entries: data,
                commitIndex: Math.min(server.commitIndex, lastIndex)
            });
            server.rpcDue[peer] = model.time + RPC_TIMEOUT;
            server.heartbeatDue[peer] = model.time + ELECTION_TIMEOUT / 2;

            // 4.2.3: This is needed to prevent the leader to reply to disruptive servers
            server.lastHeartbeat = model.time;
        }
    };

    rules.advanceCommitIndex = function (model, server) {
        var quorum = Math.floor((server.peers.length + 1)/ 2) + 1;

        var mi = util.clone(server.matchIndex);
        mi[server.id] = server.log.length;
        var n = $.map(mi, function(val) {return parseInt(val);})
                 .sort(function(a,b){return b-a;})[quorum - 1];

        if (logTerm(server.log, n) == server.term) {
            server.commitIndex = Math.max(server.commitIndex, n);
            if (server.configIndex <= server.commitIndex && server.log[server.commitIndex - 1].term === server.term) {
                // if srv to remove: remove
                var last = server.log[server.configIndex - 1];
                if (last){
                    if (!last.isAdd) {
                        var deadServerWalking = $('#server-' + last.value);
                        // If I am committing a removal entry of myself, clear the pending configurations
                        if (last.value == server.id) model.pendingConf = [];
                        if (deadServerWalking) model.deadServersWalking[last.value] = true;
                    } else {
                        delete model.deadServersWalking[last.value];
                    }
                }

                if (model.pendingConf.length)
                    raft.configChange(model, model.pendingConf.shift());
            }
        }
    };

    var handleRequestVoteRequest = function (model, server, request) {
        if (model.time - server.lastHeartbeat >= ELECTION_TIMEOUT) {
            var granted = false;
            if (server.term < request.term)
                stepDown(model, server, request.term);
            if (
                server.term == request.term &&
                (server.votedFor === null || server.votedFor == request.from) &&
                (
                    request.lastLogTerm > logTerm(server.log, server.log.length) ||
                    (
                        request.lastLogTerm == logTerm(server.log, server.log.length) &&
                        request.lastLogIndex >= server.log.length
                    )
                )
            ) {
                granted = true;
                server.votedFor = request.from;
                server.electionAlarm = makeElectionAlarm(model.time);
            }
            sendReply(model, request, {
                term: server.term,
                granted: granted,
            });
        }
    };

    var handleRequestVoteReply = function (model, server, reply) {
        if (server.term < reply.term)
            stepDown(model, server, reply.term);
        if (server.state == 'candidate' &&
            server.term == reply.term) {
            server.rpcDue[reply.from] = util.Inf;
            server.voteGranted[reply.from] = reply.granted;
        }
    };

    var handleConfigChange = function(server, entries) {
        entries
            .filter(function(e){return e.isConfig;})
            .forEach(function(conf){
                if (conf.isAdd && conf.value !== server.id) server.peers.push(conf.value);
                else server.peers = server.peers.filter(
                        function(id){return id !== conf.value;});

            });
    };

    var handleAppendEntriesRequest = function (model, server, request) {
        var success = false;
        var matchIndex = 0;
        if (server.term < request.term)
            stepDown(model, server, request.term);
        if (server.term == request.term) {
            server.state = 'follower';
            server.electionAlarm = makeElectionAlarm(model.time);
            server.lastHeartbeat = model.time;
            if (request.prevIndex === 0 ||
                (request.prevIndex <= server.log.length &&
                logTerm(server.log, request.prevIndex) == request.prevTerm)) {
                success = true;
                var index = request.prevIndex;
                for (var i = 0; i < request.entries.length; i += 1) {
                    index += 1;
                    if (logTerm(server.log, index) != request.entries[i].term) {
                        while (server.log.length > index - 1) {
                            var entry = server.log.pop();
                            if (entry.isConfig)
                                if (entry.isAdd) {
                                    server.peers = server.peers.filter(
                                        function(srv){return srv !== entry.value;});
                                    model.deadServersWalking[entry.value] = true;
                                } else server.peers.push(entry.value);
                        }
                        server.log.push(request.entries[i]);
                    }
                }
                matchIndex = index;
                server.commitIndex =
                    Math.max(server.commitIndex, request.commitIndex);
                handleConfigChange(server, request.entries);
            }
        }


        sendReply(model, request, {
            term: server.term,
            success: success,
            matchIndex: matchIndex,
        });
    };

    var handleAppendEntriesReply = function (model, server, reply) {
        if (server.term < reply.term)
            stepDown(model, server, reply.term);
        if (server.state == 'leader' &&
                server.term == reply.term &&
                server.matchIndex[reply.from] !== undefined)
        {
            if (reply.success) {
                server.matchIndex[reply.from] = Math.max(server.matchIndex[reply.from],
                    reply.matchIndex);
                server.nextIndex[reply.from] = reply.matchIndex + 1;
            } else {
                server.nextIndex[reply.from] = Math.max(1, server.nextIndex[reply.from] - 1);
            }
            server.rpcDue[reply.from] = 0;
        }
    };

    var handleMessage = function (model, server, message) {
        if (server.state == 'stopped')
            return;
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


    raft.update = function (model) {
        model.servers.forEach(function (server) {
            rules.startNewElection(model, server);
            rules.becomeLeader(model, server);
        });

        var leader = raft.getLeader(model);
        if (leader) rules.advanceCommitIndex(model, leader);

        model.servers.forEach(function (server) {
            server.peers.forEach(function (peer) {
                rules.sendRequestVote(model, server, peer);
                rules.sendAppendEntries(model, server, peer);
            });
        });

        var deliver = [];
        var keep = [];
        model.messages.forEach(function (message) {
            if (message.recvTime <= model.time)
                deliver.push(message);
            else if (message.recvTime < util.Inf && !(message.dropTime && message.dropTime <= model.time))
                keep.push(message);
        });
        model.messages = keep;
        deliver.forEach(function (message) {
            model.servers.forEach(function (server) {
                if (server.id == message.to) {
                    handleMessage(model, server, message);
                }
            });
        });

        var n = 0;
        $.each(model.deadServersWalking, function(){n++;});
        if (n) {
            var activeServers = {};
            model.servers.forEach(function(srv) {
                if (model.deadServersWalking[srv.id]) return;
                srv.peers.forEach(function(peer){
                    activeServers[peer] = true;
                });
            });

            var alive={}, dead={};
            $.each(model.deadServersWalking, function(key) {
                key = parseInt(key);
                if (activeServers[key] !== undefined) alive[key] = true;
                else dead[key] = true;
            });
            model.deadServersWalking = alive;

            var repaint = false;
            $.each(dead, function(key) {
                key = parseInt(key);
                var srv_html = $('#server-' + key);
                model.servers = model.servers.filter(
                    function(srv){return srv.id !== key;});
                srv_html.remove();
                repaint = true;
            });

            if (repaint) model.servers.forEach(graphics.realign(model.servers.length));
        }
    };

    raft.stop = function (model, server) {
        server.state = 'stopped';
        server.electionAlarm = 0;
        server.commitIndex = 0;
    };

    raft.resume = function (model, server) {
        server.state = 'follower';
        server.electionAlarm = makeElectionAlarm(model.time);
    };

    raft.resumeAll = function (model) {
        model.servers.forEach(function (server) {
            raft.resume(model, server);
        });
    };

    raft.restart = function (model, server) {
        raft.stop(model, server);
        raft.resume(model, server);
    };

    raft.drop = function (model, message) {
        model.messages = model.messages.filter(function (m) {
            return m !== message;
        });
    };

    raft.timeout = function (model, server) {
        server.state = 'follower';
        server.electionAlarm = 0;
        rules.startNewElection(model, server);
    };

    raft.clientRequest = function (model, server) {
        if (server.state == 'leader') {
            server.log.push({
                term: server.term,
                value: 'v'
            });
        }
    };

    raft.configChange = function (model, change) {
        if (change.isAdd) raft.addServer(model, change.value);
        else raft.removeServer(model, {id:change.value});

    };

    raft.addServer = function(model, id) {
        var leader = raft.getLeader(model);
        if (id === undefined) id = raft.getIdAndIncrement();

        if (leader &&
                leader.configIndex <= leader.commitIndex &&
                leader.commitIndex &&
                leader.log[leader.commitIndex-1].term === leader.term) {

            var server = raft.server(model, id);
            (function (server, peer_id) {
                // Add peer to server
                server.voteGranted[peer_id] = false;
                server.matchIndex[peer_id] = 0;
                server.nextIndex[peer_id] = 1;
                server.rpcDue[peer_id] = 0;
                server.heartbeatDue[peer_id] = 0;

                server.peers.push(peer_id);
            })(leader, server.id);
            leader.log.push({
                term: leader.term,
                value: server.id,
                isConfig: true,
                isAdd: true,
            });
            leader.configIndex = leader.log.length;

            // Graphics
            model.servers.forEach(graphics.realign(model.servers.length + 1));
            model.servers.push(server);
            model.deadServersWalking[server.id]=true;
            graphics.get_creator(model.servers.length)(server, model.servers.length - 1);
        } else {
            model.pendingConf.push({isAdd: true, value: id});
        }
    };

    raft.removeServer = function (model, server) {
        var leader = raft.getLeader(model);

        // If the server has already been removed (find returned -1), do not create a log entry
        if (model.servers.findIndex(function(srv){return srv.id === server.id;}) < 0) return;

        if (leader &&
                leader.configIndex <= leader.commitIndex &&
                leader.commitIndex &&
                leader.log[leader.commitIndex-1].term === leader.term) {

            // Remove from leader
            (function (server, peer_id) {
                // remove peer from server
                delete server.voteGranted[peer_id];
                delete server.matchIndex[peer_id];
                delete server.nextIndex[peer_id];
                delete server.rpcDue[peer_id];
                delete server.heartbeatDue[peer_id];

                server.peers = server.peers.filter(
                        function(srv){return srv !== peer_id;});
            })(leader, server.id);

            leader.log.push({
                term: leader.term,
                value: server.id,
                isConfig: true,
                isAdd: false,
            });

            leader.configIndex = leader.log.length;
        } else {
            model.pendingConf.push({isAdd: false, value: server.id});
        }
    };

    raft.getLeader = function (model) {
        var leader = null;
        var term = 0;
        model.servers.forEach(function (server) {
            if (server.state == 'leader' &&
                server.term > term) {
                leader = server;
                term = server.term;
            }
        });
        return leader;
    };

})();
