/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
'use strict';

var makeState = function(initial) {
  var checkpoints = [];
  var maxTime = 0;
  var timers = [];
  var prev = function(time) {
      return util.greatestLower(checkpoints,
                                function(m) { return m.time > time; });
  };
  var runTimers = function(time) {
    var fire = [];
    timers = timers.filter(function(timer) {
      if (timer.time <= time) {
        fire.push(timer);
        return false;
      } else {
        return true;
      }
    });
    fire.forEach(function(timer) {
      timer.callback();
    });
  };
  var self = {
    current: initial,
    getMaxTime: function() {
      return maxTime;
    },
    init: function() {
      checkpoints.push(util.clone(self.current));
    },
    fork: function() {
      var i = prev(self.current.time);
      while (checkpoints.length - 1 > i)
        checkpoints.pop();
      maxTime = self.current.time;
      timers = [];
    },
    rewind: function(time) {
      self.current = util.clone(checkpoints[prev(time)]);
      self.current.time = time;
      runTimers(time);
    },
    base: function() {
      return checkpoints[prev(self.current.time)];
    },
    advance: function(time) {
      maxTime = time;
      self.current.time = time;
      if (self.updater(self))
        checkpoints.push(util.clone(self.current));
      runTimers(time);
    },
    save: function() {
      checkpoints.push(util.clone(self.current));
    },
    seek: function(time) {
      if (time <= maxTime) {
        self.rewind(time);
      } else if (time > maxTime) {
        self.advance(time);
      }
    },
    updater: function() { return false; },
    exportToString: function() {
      return JSON.stringify({
        checkpoints: checkpoints,
        maxTime: maxTime,
      });
    },
    importFromString: function(s) {
      var o = JSON.parse(s);
      checkpoints = o.checkpoints
      maxTime = o.maxTime;
      self.current = util.clone(checkpoints[0]);
      self.current.time = 0;
      timers = [];
    },
    clear: function() {
      checkpoints = [];
      self.current = initial;
      self.current.time = 0;
      maxTime = 0;
      timers = [];
    },
    schedule: function(time, callback) {
      timers.push({time: time, callback: callback});
    },
  };
  self.current.time = 0;
  return self;
};
