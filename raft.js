/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global graphics */
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

    raft.server = function (model, auto_add) {
        var peers = model.servers.map(function (server) {return server.id;});
        if (auto_add) {
            model.servers.map(function (peer_id) {
                return function(server){
                    addPeer(server, peer_id);
                };
            }(NEXT_SERVER_ID));
        }

        return {
            id: NEXT_SERVER_ID++,
            peers: peers,
            state: 'follower',
            term: 1,
            votedFor: null,
            log: [],
            commitIndex: 0,
            configIndex: 0,
            electionAlarm: makeElectionAlarm(model.time),
            voteGranted: util.makeMap(peers, false),
            matchIndex: util.makeMap(peers, 0),
            nextIndex: util.makeMap(peers, 1),
            rpcDue: util.makeMap(peers, 0),
            heartbeatDue: util.makeMap(peers, 0),
        };
    };


    var stepDown = function (model, server, term) {
        server.term = term;
        server.state = 'follower';
        server.votedFor = null;
        if (server.electionAlarm <= model.time || server.electionAlarm == util.Inf) {
            server.electionAlarm = makeElectionAlarm(model.time);
        }
    };

    rules.startNewElection = function (model, server) {
        if ((server.state == 'follower' || server.state == 'candidate') &&
            server.electionAlarm <= model.time) {
            server.electionAlarm = makeElectionAlarm(model.time);
            server.term += 1;
            server.votedFor = server.id;
            server.state = 'candidate';
            server.voteGranted = util.makeMap(server.peers, false);
            server.matchIndex = util.makeMap(server.peers, 0);
            server.nextIndex = util.makeMap(server.peers, 1);
            server.rpcDue = util.makeMap(server.peers, 0);
            server.heartbeatDue = util.makeMap(server.peers, 0);
            // server.heartbeatDue = util.makeMap(server.peers, util.Inf);
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
            util.countTrue(util.mapValues(server.voteGranted)) + 1 > Math.floor(model.servers.length / 2)) {
            server.state = 'leader';
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
            /* TODO: data.length check */
            // if (data.length)
            server.rpcDue[peer] = model.time + RPC_TIMEOUT;
            server.heartbeatDue[peer] = model.time + ELECTION_TIMEOUT / 2;
        }
    };

    rules.advanceCommitIndex = function (model, server) {
        if (server.state != 'leader') return;

        var matchIndexes = util.mapValues(server.matchIndex).concat(server.log.length);
        matchIndexes.sort(util.numericCompare);
        var n = matchIndexes[Math.floor(model.servers.length / 2)];
        if (logTerm(server.log, n) == server.term) {
            server.commitIndex = Math.max(server.commitIndex, n);
            if (model.pendingConf.length &&
                    server.configIndex <= server.commitIndex)
                raft.configChange(model, model.pendingConf.shift());
        }
    };

    rules.helpCatchUp = function (model, leader, server) {
        console.error("Not yet implemented");
        return;
    };

    var handleRequestVoteRequest = function (model, server, request) {
        if (server.term < request.term)
            stepDown(model, server, request.term);
        var granted = false;
        if (server.term == request.term &&
            (server.votedFor === null ||
            server.votedFor == request.from) &&
            (request.lastLogTerm > logTerm(server.log, server.log.length) ||
            (request.lastLogTerm == logTerm(server.log, server.log.length) &&
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
                if (conf.isAdd) addPeer(server, conf.value);
                else removePeer(server, conf.value);
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
            if (request.prevIndex === 0 ||
                (request.prevIndex <= server.log.length &&
                logTerm(server.log, request.prevIndex) == request.prevTerm)) {
                success = true;
                var index = request.prevIndex;
                for (var i = 0; i < request.entries.length; i += 1) {
                    index += 1;
                    if (logTerm(server.log, index) != request.entries[i].term) {
                        while (server.log.length > index - 1) {
                            // TODO: if Entry is config, rollback
                            server.log.pop();
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
            rules.advanceCommitIndex(model, server);
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
    };

    raft.stop = function (model, server) {
        server.state = 'stopped';
        server.electionAlarm = 0;
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
        if (change.isAdd) raft.addServer(model);
        if (change.isRemove) raft.removeServer(model, change.value);

    };

    var addPeer = function (server, peer_id) {
        var patch = {'voteGranted': {}, 'matchIndex': {}, 'nextIndex': {}, 'rpcDue': {}, 'heartbeatDue': {}};
        patch.voteGranted[peer_id] = false;
        patch.matchIndex[peer_id] = 0;
        patch.nextIndex[peer_id] = 1;
        patch.rpcDue[peer_id] = 0;
        patch.heartbeatDue[peer_id] = 0;

        server.peers.push(peer_id);
        jQuery.extend(true, server, patch);
    };

    var removePeer = function (server, peer_id) {
        cosole.error("Not yet implementd");
    };

    raft.addServer = function(model) {
        var leader = raft.getLeader(model);
        if (leader && leader.configIndex <= leader.commitIndex) {
            // leader.helpCatchUp(model, leader, server);
            var server = raft.server(model);
            addPeer(leader, server.id);
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
            graphics.get_creator(model.servers.length)(server, model.servers.length - 1);
        } else {
            model.pendingConf.push({isAdd: true});
        }
    };

    raft.removeServer = function (model, server_id) {
        console.error("Not yet implemented");
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
