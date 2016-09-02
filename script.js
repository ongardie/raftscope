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
var INITIAL_SERVER_NUMBER = 5;

$(function () {

    // Initializes servers and state
    state = makeState({
        servers: [],
        messages: [],
        channelNoise: 0,
    });

    (function () {
        for (var i = 1; i <= INITIAL_SERVER_NUMBER; i += 1) {
            state.current.servers.push(raft.server(state.current));
        }
    })();

    state.current.servers.forEach(graphics.get_creator(state.current.servers.length));


    // Disabled for now, they don't seem to behave reliably.
    // // enable tooltips
    // $('[data-toggle="tooltip"]').tooltip();

    // state.updater = function (state) {
    //     raft.update(state.current);
    //     var time = state.current.time;
    //     var base = state.base(time);
    //     state.current.time = base.time;
    //     var same = util.equals(state.current, base);
    //     state.current.time = time;
    //     return !same;
    // };

    state.init();
    render.update();

});
