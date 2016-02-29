// Babel ES6/JSX Compiler
require('babel-register');
require("babel-polyfill");

var path = require('path');
var bodyParser = require('koa-bodyparser');
var compress = require('koa-compress')
var favicon = require('koa-favicon');
var logger = require('koa-logger');
var serve = require('koa-static');
var render = require('koa-ejs');
var async = require('async');
var colors = require('colors');
var mongoose = require('mongoose');
var React = require('react');
var ReactDOM = require('react-dom/server');
var Router = require('react-router');

var config = require('./config');
var routes = require('./app/routes');

var koa = require('koa');
var app = koa();
render(app, {
  root: path.join(__dirname, 'views'),
  layout: false,
  // viewExt: 'html',
  cache: false,
  debug: true
});

mongoose.connect(config.database);
mongoose.connection.on('error', function() {
  console.info('Error: Could not connect to MongoDB. Did you forget to run `mongod`?'.red);
});

app.use(compress());

function ignoreAssets(mw) {
  return function *(next){
    if (/(\.js|\.css|\.ico|\.woff2)$/.test(this.path)) {
      yield next;
    } else {
      // must .call() to explicitly set the receiver
      // so that "this" remains the koa Context
      yield mw.call(this, next);
    }
  }
}

app.use(ignoreAssets(logger('dev')));
app.use(bodyParser());
// app.use(bodyParser.urlencoded({ extended: false }));
app.use(favicon(path.join(__dirname, 'public', 'favicon.png')));
app.use(serve(path.join(__dirname, 'public')));

var router = require('./router');
app.use(router.routes());
app.use(router.allowedMethods());

app.use(function *(next) {
  var reactString = '';
  Router.match({
    routes: routes.default,
    location: this.url,
  }, function(err, redirectLocation, renderProps) {
    if (err) {
      this.throw(error.message, 500);
    } else if (redirectLocation) {
      this.redirect(redirectLocation.pathname + redirectLocation.search);
    } else if (renderProps) {
      reactString = ReactDOM.renderToString(React.createElement(Router.RoutingContext, renderProps));
    } else {
      this.throw('Not Found', 404);
    }
  });
  yield this.render('index', { body: reactString });
});

app.use(function *(next) {
  console.log(err.stack.red);
  this.status = err.status || 500;
  this.body = { message: err.message };
  yield next;
});

/**
 * Socket.io stuff.
 */
var server = require('http').createServer(app.callback());
var io = require('socket.io')(server);
var onlineUsers = 0;

io.sockets.on('connection', function(socket) {
  onlineUsers++;

  io.sockets.emit('onlineUsers', { onlineUsers: onlineUsers });

  socket.on('disconnect', function() {
    onlineUsers--;
    io.sockets.emit('onlineUsers', { onlineUsers: onlineUsers });
  });
});

server.listen(process.env.PORT || 3000, function() {
  console.log('Express server listening on port ' + (process.env.PORT || 3000));
});
