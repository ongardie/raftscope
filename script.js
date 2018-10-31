/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global raft */
/* global makeState */
/* global render */
/* global graphics */
/* global playback */
/* global presenter */
/* global util */
/* global speedSlider */
'use strict';

var state;
var INITIAL_SERVER_NUMBER = 4;

$(function () {

    // Initializes servers and state
    state = makeState({ // this is "current"
        servers: [],
        messages: [],
        pendingConf: [],
        deadServersWalking: {},
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

    // This is the main function which determines each tick in the simulation
    (function () {
        var last = null;
        var step = function (timestamp) {
            if (!playback.isPaused() && last !== null && timestamp - last < 500) {
                var wallMicrosElapsed = (timestamp - last) * 1000;
                var speed = util.speedSliderTransform(speedSlider.slider('getValue'));
                var modelMicrosElapsed = wallMicrosElapsed / speed;
                var modelMicros = state.current.time + modelMicrosElapsed;
                state.seek(modelMicros);
                if (modelMicros >= state.getMaxTime() && presenter.recorder.onReplayDone !== undefined) {
                    var f = presenter.recorder.onReplayDone;
                    presenter.recorder.onReplayDone = undefined;
                    f();
                }
                render.update();
            }
            last = timestamp;
            window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    })();

});
