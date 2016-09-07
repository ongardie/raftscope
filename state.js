/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global graphics */
/* global raft */
/* global render */
'use strict';

var makeState = function (initial) {
    var checkpoints = [];
    var maxTime = 0;
    var prev = function (time) {
        return util.greatestLower(checkpoints,
            function (m) {
                return m.time > time;
            });
    };
    var self = {
        current: initial,
        getMaxTime: function () {
            return maxTime;
        },
        init: function () {
            checkpoints.push(util.clone(self.current));
        },
        fork: function () {
            var i = prev(self.current.time);
            while (checkpoints.length - 1 > i)
                checkpoints.pop();
            maxTime = self.current.time;
        },
        fixGraphicsOnTimeChange: function(time, current, next) {
            var create = graphics.get_creator(next.servers.length);

            // Add missing servers
            var toAdd = util.srvArraySub(next.servers, current.servers);
            toAdd.forEach(function(server) {
                create(server, raft.getServerIndexById(next, server.id));
            });

            // Remove leftovers
            var toRem = util.srvArraySub(current.servers, next.servers);
            toRem.forEach(function(server) {
                $('#server-' + server.id).remove();
            });

            // realign
            next.servers.forEach(graphics.realign(next.servers.length));
            render.update();

        },
        rewind: function (time) {
            // HANDLE: graphics changes
            var next = util.clone(checkpoints[prev(time)]);
            self.fixGraphicsOnTimeChange(time, self.current, next);
            self.current = next;
            self.current.time = time;
        },
        base: function () {
            return checkpoints[prev(self.current.time)];
        },
        advance: function (time) {
            maxTime = time;
            self.current.time = time;
            if (self.updater(self))
                checkpoints.push(util.clone(self.current));
        },
        save: function () {
            checkpoints.push(util.clone(self.current));
        },
        seek: function (time) {
            if (time <= maxTime) {
                self.rewind(time);
            } else if (time > maxTime) {
                self.advance(time);
            }
        },
        updater: function () {
            raft.update(self.current);
            var time = self.current.time;
            var base = self.base(time);
            self.current.time = base.time;
            var same = util.equals(self.current, base);
            self.current.time = time;
            return !same;
        },

        // Used in presenter.js
        exportToString: function () {
            return JSON.stringify({
                checkpoints: checkpoints,
                maxTime: maxTime,
            });
        },
        importFromString: function (s) {
            var o = JSON.parse(s);
            checkpoints = o.checkpoints;
            maxTime = o.maxTime;
            self.current = util.clone(checkpoints[0]);
            self.current.time = 0;
        },
        clear: function () {
            checkpoints = [];
            self.current = initial;
            self.current.time = 0;
            maxTime = 0;
        },
    };
    self.current.time = 0;
    return self;
};
