var svg;
var circle;

$(function() {

svg = $('svg');
circle = $('circle', svg);
var update = function() {
  circle.attr('cy', circle.attr('cy') * 1 + 1);
  setTimeout(update, 10);
};
setTimeout(update, 10);

});
