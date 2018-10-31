/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global raft */
/* global state */
/* global render */
/* global playback */
/* global speedSlider */
/* global MAX_RPC_LATENCY */
'use strict';

var presenter = {};

$(function () {
    presenter.recorder = {};

    presenter.recorder.onReplayDone = undefined;
    presenter.recorder.record = function (name) {
        localStorage.setItem(name, state.exportToString());
    };

    presenter.recorder.replay = function (name, done) {
        state.importFromString(localStorage.getItem(name));
        render.update();
        presenter.recorder.onReplayDone = done;
    };

    $("#help").click(function () {
        playback.pause();
        $('#modal-help').modal('show');
    });

    $("#reset-simulation").click(function () {
        state.clear();
        state.save();
        playback.pause();
        render.update();
    });

    $(window).keyup(function (e) {
        if (e.target.id == "title")
            return;
        var leader = raft.getLeader(state.current), processed = false;
        if (e.keyCode == ' '.charCodeAt(0) || e.keyCode == 190 /* dot, emitted by Logitech remote */) {
            $('.modal').modal('hide');
            playback.toggle();
            processed = true;
        } else if (e.keyCode == 'C'.charCodeAt(0)) {
            if (leader !== null) {
                state.fork();
                raft.clientRequest(state.current, leader);
                state.save();
                render.update();
                $('.modal').modal('hide');
            }
            processed = true;
        } else if (e.keyCode == 'R'.charCodeAt(0)) {
            if (leader !== null) {
                state.fork();
                raft.stop(state.current, leader);
                raft.resume(state.current, leader);
                state.save();
                render.update();
                $('.modal').modal('hide');
            }
            processed = true;
        } else if (e.keyCode == 'T'.charCodeAt(0)) {
            state.fork();
            raft.spreadTimers(state.current);
            state.save();
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 'A'.charCodeAt(0)) {
            state.fork();
            raft.alignTimers(state.current);
            state.save();
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 'L'.charCodeAt(0)) {
            state.fork();
            playback.pause();
            raft.setupLogReplicationScenario(state.current);
            state.save();
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 'B'.charCodeAt(0)) {
            state.fork();
            raft.resumeAll(state.current);
            state.save();
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 'F'.charCodeAt(0)) {
            state.fork();
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 191 && e.shiftKey) { /* question mark */
            playback.pause();
            $('#modal-help').modal('show');
            processed = true;
        } else if (e.keyCode == 107 || e.keyCode == 221) { /* numpad + and keyboard ] */
            speedSlider.slider('setValue', util.clamp(speedSlider.slider('getValue') - 0.3, 0, 3));
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 109 || e.keyCode == 219) { /* numpad - and keyboard [ */
            speedSlider.slider('setValue', util.clamp(speedSlider.slider('getValue') + 0.3, 0, 3));
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 'N'.charCodeAt(0)) {
            speedSlider.slider('setValue', 2.0);
            render.update();
            $('.modal').modal('hide');
            processed = true;
        } else if (e.keyCode == 'G'.charCodeAt(0)) {
            state.fork();
            raft.addServer(state.current);
            state.save();
            render.update();
            $('.modal').modal('hide');
            processed = true;
        }
        // else if (e.keyCode == 'J'.charCodeAt(0)) {
        //     e.preventDefault();
        //     state.clear();
        //     state.save();
        //     playback.pause();
        //     render.update();
        // }
        return !processed;
    });

    raft.spreadTimers = function (model) {
        console.log("SPREAD");

        var timers = [];
        model.servers.forEach(function (server) {
            if (server.electionAlarm > model.time &&
                server.electionAlarm < util.Inf) {
                timers.push({timeout: server.electionAlarm, server: server});
            }
        });
        timers.sort(function (a, b) {
            return a.timeout - b.timeout;
        });

        if (timers.length > 1 &&
            timers[1].timeout - timers[0].timeout < MAX_RPC_LATENCY) {
            if (timers[0].timeout > model.time + MAX_RPC_LATENCY) {
                timers[0].server.electionAlarm -= MAX_RPC_LATENCY;
            } else {
                model.servers.forEach(function (server) {
                    if (server.electionAlarm > timers[0].timeout &&
                        server.electionAlarm < timers[0].timeout + MAX_RPC_LATENCY) {
                        server.electionAlarm += MAX_RPC_LATENCY;
                    }
                });
            }
        }
    };

    raft.alignTimers = function (model) {
        raft.spreadTimers(model);
        var timers = [];
        model.servers.forEach(function (server) {
            if (server.electionAlarm > model.time &&
                server.electionAlarm < util.Inf) {
                timers.push(server.electionAlarm);
            }
        });
        timers.sort(util.numericCompare);
        model.servers.forEach(function (server) {
            if (server.electionAlarm == timers[1]) {
                server.electionAlarm = timers[0];
            }
        });
    };

    raft.setupLogReplicationScenario = function (model) {
        var s1 = model.servers[0];
        raft.restart(model, model.servers[1]);
        raft.restart(model, model.servers[2]);
        raft.restart(model, model.servers[3]);
        raft.restart(model, model.servers[4]);
        raft.timeout(model, model.servers[0]);
        raft.rules.startNewElection(model, s1);
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
        raft.rules.becomeLeader(model, s1);
        raft.clientRequest(model, s1);
        raft.clientRequest(model, s1);
        raft.clientRequest(model, s1);
    };

});
