'use strict';

var leaderElection;
var logReplication;
var safety;
var heading;
var slides;
var showSlide;

var safetys;

$(function() {

var SVG = function(tag) {
   return $(document.createElementNS('http://www.w3.org/2000/svg', tag));
};

var section = $('#modal-section');
heading = function(title, subtitle) {
  $('h1', section).text(title || '');
  $('h2', section).text(subtitle || '');
  section.modal();
  playback.pause();
};

safetys = function() {
  heading('Safety', 'Voting Rule');
  var safetySection =
    $('<div id="modal-safetysection" class="modal" tabindex="-1" data-keyboard="true"></div>')
      .html(section.html());
  section.modal('hide');
  safetySection.modal();
  var svg = $('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" style="border: 0px solid black" width="450" height="230"></svg>');
  var logsg = SVG('g')
    .attr('class', 'logs');
  svg.append(logsg);

  var logs = [
    [2, 2, 2, 3, 4],
    [2, 2, 2, 3, 3, 3],
    [2, 2, 2, 3],
  ].map(function(l) {
    return l.map(function(term) {
      return {term: term};
    });
  });

  var logsSpec = {
    x: 30,
    y: 0,
    width: 420,
    height: 230,
  };

  var INDEX_HEIGHT = 30;
  var height = (logsSpec.height - INDEX_HEIGHT) / 3;

  var indexSpec = {
    x: logsSpec.x + logsSpec.width * 0.05,
    y: logsSpec.y + 2*height/6,
    width: logsSpec.width * 0.9,
    height: 2*height/3,
  };
  var indexes = SVG('g')
    .attr('id', 'log-indexes');
  logsg.append(indexes);
  for (var index = 1; index <= 10; ++index) {
    var indexEntrySpec = {
      x: indexSpec.x + (index - 0.5) * indexSpec.width / 11,
      y: indexSpec.y,
      width: indexSpec.width / 11,
      height: indexSpec.height,
    };
    indexes
        .append(SVG('text')
          .attr(indexEntrySpec)
          .text(index));
  }

  logs.forEach(function(log, logi) {
    var logSpec = {
      x: logsSpec.x + logsSpec.width * 0.05,
      y: logsSpec.y + INDEX_HEIGHT + height * logi + 1*height/6,
      width: logsSpec.width * 0.9,
      height: 2*height/3,
    };
    var logEntrySpec = function(index) {
      return {
        x: logSpec.x + (index - 1) * logSpec.width / 11,
        y: logSpec.y,
        width: logSpec.width / 11,
        height: logSpec.height,
      };
    };
    var logg = SVG('g');
    logsg.append(logg);
    for (var index = 1; index <= 10; ++index) {
      logg.append(SVG('rect')
          .attr(logEntrySpec(index))
          .attr('class', 'log'));
    }

    var renderEntry = function(spec, entry) {
      var e = render.entry(spec, entry, true);
      var rect = $('rect', e);
      rect.attr('style', rect.attr('style') + '; stroke-width: .5');
      return e;
    };
    log.forEach(function(entry, i) {
      var index = i + 1;
      logg.append(renderEntry(
             logEntrySpec(index),
             entry));
    });
  });

  $('div.modal-header div', safetySection).attr('style', '');
  $('div.modal-content', safetySection)
    .append($('<div class="modal-body"></div>')
      .append($('<div style="padding-left: 10px"></div>')
                .append('<h3>Compare terms of last entries, break ties with log length</h3>')
                .append(svg)));
};

leaderElection = function() {
  replay('leader election', logReplication);
  state.schedule(  1000, function() {
    heading('Leader Election');
  });
  state.schedule(182000, playback.pause);
  state.schedule(276000, playback.pause);
  state.schedule(289000, playback.pause);
  state.schedule(326000, playback.pause);
  state.schedule(327000, function() {
    heading('Leader Election', 'Split Votes');
  });
  state.schedule(424000, playback.pause);
  state.schedule(438000, playback.pause);
  state.schedule(483000, playback.pause);
  state.schedule(596000, playback.pause);
};

logReplication = function() {
  $('.logs').show();
  heading('Log Replication');
  replay('log replication', playback.pause);
  state.schedule(     1, playback.pause);
  state.schedule( 28000, playback.pause);
  state.schedule(131000, playback.pause);
  state.schedule(176000, playback.pause);
  state.schedule(280000, playback.pause);
  state.schedule(281000, function() {
    heading('Log Replication', 'Repairing Inconsistencies');
  });
  state.schedule(282000, function() {
    state.seek(397000);
    playback.pause();
  });
  state.schedule(413000, playback.pause);
  state.schedule(567000, playback.pause);
  state.schedule(568000, function () {
    state.seek(647000);
  });
  state.schedule(650000, playback.pause);
  state.schedule(697000, playback.pause);
  state.schedule(698000, safety);
};

safety = function() {
  replay('log replication', safetys);
  state.seek(706000);
  heading('Safety');
  state.schedule(706100, playback.pause);
  state.schedule(836000, playback.pause);
  state.schedule(872000, playback.pause);
};

slides = function() {/*
    <div>
      <div class="modal-dialog modal-lg">
        <div class="modal-content slide">
          <div class="modal-body">
            <div class="text-center" style="padding-top: 100px">
              <h1 class="blue">In Search of an Understandable Consensus Algorithm</h1>
              <h3 class="gray" style="padding-top: 10px;">Diego Ongaro and John Ousterhout</h3>
              <h3 class="gray">Stanford University</h3>
            </div>
          </div>
        </div>
      </div>
    </div>


    <div>
      <div class="modal-dialog modal-lg">
        <div class="modal-content slide">
          <div class="modal-header">
            <h2>Introduction</h2>
          </div>
          <div class="modal-body">
            <ul>
              <li><p>Consensus: agreement on shared state</p></li>
              <li><p>System is up if majority of servers are up</p></li>
              <li><p>Needed for consistent, fault-tolerant storage systems</p></li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <div>
      <div class="modal-dialog modal-lg">
        <div class="modal-content slide">
          <div class="modal-header">
            <h2>Paxos widely regarded as difficult</h2>
          </div>
          <div class="modal-body">
            <blockquote>
              <p>The dirty little secret of the NSDI community is that at most five people really, truly understand every part of Paxos ;-).</p>
              <footer>NSDI reviewer</footer>
            </blockquote>
            <blockquote>
              <p>There are significant gaps between the description of the Paxos algorithm and the needs of a real-world system.&hellip; the final system will be based on an unproven protocol.</p>
              <footer>Chubby authors</footer>
            </blockquote>
          </div>
        </div>
      </div>
    </div>

    <div>
      <div class="modal-dialog modal-lg">
        <div class="modal-content slide">
          <div class="modal-header">
            <h2>Raft: Designed for Understandability</h2>
          </div>
          <div class="modal-body">
            <img class="pull-left" height="270" src="studyscatter.png" />
            <img class="pull-right" style="margin-top: 72px" height="265" src="survey.png" />
          </div>
        </div>
      </div>
    </div>

    <div>
      <div class="modal-dialog modal-lg">
        <div class="modal-content slide">
          <div class="modal-header">
            <h2>Raft Overview</h2>
          </div>
          <div class="modal-body">
            <ol>
              <li><p>Leader election</p>
                <ul>
                  <li><p>Select one of the servers to act as cluster leader</p></li>
                </ul>
              </li>
              <li><p>Log replication (normal operation)</p>
                <ul>
                  <li><p>Leader takes commands from clients, appends them to its log</p></li>
                  <li><p>Leader replicates its log to other servers (overwriting inconsistencies)</p></li>
                </ul>
              </li>
              <li><p>Safety</p>
                <ul>
                  <li><p>Only a server with an up-to-date log can become leader</p></li>
                </ul>
            </ol>
          </div>
        </div>
      </div>
    </div>

    <div>
      <div class="modal-dialog modal-lg">
        <div class="modal-content slide">
          <div class="modal-header">
            <h2>Conclusions</h2>
          </div>
          <div class="modal-body">
            <ul>
              <li><p>Consensus widely regarded as difficult</p></li>
              <li><p>Raft designed for understandability</p>
                <ul>
                  <!--
                  <li><p>Better problem decomposition</p></li>
                  <li><p>Reduced state space complexity, less mechanism</p></li>
                  -->
                  <li><p>Easier to teach in classrooms</p></li>
                  <li><p>Better foundation for building practical systems</p></li>
                </ul>
              </li>
              <li><p>Additional topics:</p>
                <ul>
                  <li><p>Cluster membership changes (paper)</p></li>
                  <li><p>Log compaction and client interaction (TR)</p></li>
                </ul>
              </li>
              <li><p>http://raftconsensus.github.io</p></li>
            </ul>
          </div>
        </div>
      </div>
    </div>
*/}.toString().slice(15,-3);
slides = $('div.modal-dialog', slides).parent();
slides.each(function(i, s) {
  $(s).addClass('modal')
      .attr('tabindex', '-1')
      .attr('data-keyboard', 'true');
});

showSlide = function(num) {
  $('.modal').modal('hide');
  slides.eq(num).modal();
};

var slideIndex = 0;

//playback.pause();
setTimeout(leaderElection, 0);
//showSlide(0);

/*
$(window).keyup(function(e) {
  if (e.keyCode == 33) { // pgup
    slideIndex = Math.max(slideIndex - 1, 0);
    showSlide(slideIndex);
  } else if (e.keyCode == 34) { // pgdn
    slideIndex = Math.min(slideIndex + 1, slides.length - 1);
    showSlide(slideIndex);
  }
});
*/

$('.logs').hide();

});
