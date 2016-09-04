/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global raft */
/* global makeState */
/* global render */
/* global graphics */
'use strict';

var state;
var INITIAL_SERVER_NUMBER = 4;

$(function () {

    // Initializes servers and state
    state = makeState({ // this is "current"
        servers: [],
        messages: [],
        pendingConf: [],
        channelNoise: 0,
    });

    (function () {
        for (var i = 1; i <= INITIAL_SERVER_NUMBER; i += 1) {
            state.current.servers.push(raft.server(state.current, raft.getIdAndIncrement()));
        }
    })();

    state.current.servers.forEach(graphics.get_creator(state.current.servers.length));


    // Disabled for now, they don't seem to behave reliably.
    // // enable tooltips
    // $('[data-toggle="tooltip"]').tooltip();

    state.init();
    render.update();
});
