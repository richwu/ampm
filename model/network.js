var os = require('os'); // http://nodejs.org/api/os.html
var path = require('path'); //http://nodejs.org/api/path.html
var http = require('http'); // HTTP support. http://nodejs.org/api/http.html
var _ = require('lodash'); // Utilities. http://underscorejs.org/
var Backbone = require('backbone'); // Data model utilities. http://backbonejs.org/
var fs = require('node-fs'); // Recursive directory creation. https://github.com/bpedro/node-fs
var express = require('express'); // Routing framework. http://expressjs.com/
var session = require('express-session');
var cookieParser = require('cookie-parser');
var osc = require('node-osc'); // OSC server. https://github.com/TheAlphaNerd/node-osc
var ioServer = require('socket.io'); // Web socket implementation. http://socket.io/
var ioClient = require('socket.io-client'); // Web socket implementation. http://socket.io/
var connect = require('connect');
var passport = require('passport');
var passportSocketIo = require('passport.socketio');
var DigestStrategy = require('passport-http').DigestStrategy;

var BaseModel = require('./baseModel.js').BaseModel;

// Initialize and manage the various network transports.
exports.Network = BaseModel.extend({
	defaults: {
		// The port used to communicate between node and the browser. This is also the URL you'd use
		// to access the console, such as http://localhost:81.
		socketToConsolePort: 81,

		// The port used to communicate between node and the client app over a TCP socket. This is
		// used for the app to send log messages and event tracking.
		socketToAppPort: 3001,

		// The port used to communicate from the client app to the server over UDP/OSC. 
		oscFromAppPort: 3002,

		// The port used to communicate from the server to the client app over UDP/OSC.
		oscToAppPort: 3003,

		// The port used to communicate from the server to another peer over UDP/OSC.
		oscToPeerPort: 3004,

		// How often in ms to send state changes to peers.
		stateSyncRate: 1000 / 60,

		// A listing of hostnames of peers with whom to share state.
		peers: null,

		// Which hostname is the "master" keeper of shared state.
		master: null
	},

	transports: null,


	initialize: function() {
		BaseModel.prototype.initialize.apply(this);

		this.isMaster = this.get('master') && this.get('master').toLowerCase() == os.hostname().toLowerCase();

		this.transports = {};

		//// Set up authentication.

		// A secret used to encrypt session cookies.
		var secret = '_notsosecret';
		// An object in which sessions are stored.
		var store = new session.MemoryStore();

		// Using digest auth -- http://passportjs.org/guide/basic-digest/
		if ($$config.permissions) {
			passport.use(new DigestStrategy({
					qop: 'auth'
				},
				function(username, done) {
					var permissions = $$config.permissions ? $$config.permissions[username] : null;
					if (permissions) {
						// The username is passed here, return the password for that user.
						return done(null, username, permissions.password);
					} else {
						// Invalid user.
						return done(null, false);
					}
				}
			));
		}

		// Convert a user to some kind of identifier.
		passport.serializeUser(function(user, done) {
			done(null, user);
		});

		// Convert an identifier back into a user object.
		passport.deserializeUser(function(id, done) {
			done(null, id);
		});

		//// Set up web server.
		global.app = express();
		this.transports.webServer = http.createServer(app).listen(this.get('socketToConsolePort'));

		// Any requests to /static will just get raw files from the view folder.
		app.use('/static', express.static(path.resolve(__dirname + '/../view')));

		// More auth stuff.
		app.use(cookieParser(secret));
		app.use(session({
			store: store,
			key: 'sessionId',
			secret: secret,
			resave: false,
			saveUninitialized: true
		}));
		app.use(passport.initialize());
		app.use(passport.session());
		
		if ($$config.permissions) {
			app.get('/', passport.authenticate('digest', {
				session: true
			}), function(req, res) {
				res.sendFile(path.resolve(__dirname + '/../view/index.html'));
			});
		} else {
			app.get('/', function(req, res) {
				res.sendFile(path.resolve(__dirname + '/../view/index.html'));
			});
		}

		///// Set up socket connection to console.
		this.transports.socketToConsole = ioServer.listen(this.transports.webServer);

		if ($$config.permissions) {
			this.transports.socketToConsole.configure(_.bind(function() {
				// Yet more auth stuff.
				this.transports.socketToConsole.set('authorization', passportSocketIo.authorize({
					cookieParser: express.cookieParser,
					key: 'sessionId',
					secret: secret,
					store: store,
					success: function(data, accept) {
						logger.info('Socket access authorized for user', data.user);
						accept(null, true);
					},
					fail: function(data, message, error, accept) {
						logger.info('Socket access unauthorized.', message, error);
						accept(null, false);
					}
				}));
			}, this));
		}

		//// Set up OSC connection from app.
		this.transports.oscFromApp = new osc.Server(this.get('oscFromAppPort'));

		// handle straight messages
		this.transports.oscFromApp.on('message', _.bind(function(message, info) {
			// handle bundles
			if (message[0] == '#bundle')
				this._handleOsc(this.transports.oscFromApp, message[2], info);
			else
				this._handleOsc(this.transports.oscFromApp, message, info);
		}, this));

		//// Set up OSC connection to app.
		this.transports.oscToApp = new osc.Client('127.0.0.1', this.get('oscToAppPort'));

		//// Set up socket connection to app.
		this.transports.socketToApp = ioServer.listen(this.get('socketToAppPort'));

		//// Load the shared state plugin.
		if ($$config.sharedState && $$sharedState.shared) {
			var peers = this.get('peers');
			var myName = os.hostname();
			if (!this.isMaster) {
				peers = [this.get('master')];
			}

			// The master will continuously send state to all peers.
			// If not master, it'll just send state to the master.
			this.transports.peers = {};
			for (var i in peers) {
				this.transports.peers[i] = new osc.Client(peers[i], this.get('oscToPeerPort'));
			}
			setInterval(_.bind(function() {
				var state = JSON.stringify($$sharedState.shared);
				for (var i in this.transports.peers) {
					this.transports.peers[i].send('/sharedState', state);
				}
			}, this), this.get('stateSyncRate'));

			// Process state updates from the master and send on to the app.
			this.transports.oscFromPeer = new osc.Server(this.get('oscToPeerPort'));
			this.transports.oscFromPeer.on('message', _.bind(function(message, info) {
				this._handleOsc(this.transports.oscFromPeer, message, info);
			}, this));
			this.transports.oscFromPeer.on('sharedState', _.bind(function(data) {
				_.merge($$sharedState.shared, data);
				this.transports.oscToApp.send('/sharedState', JSON.stringify($$sharedState.shared));
			}, this));
		}
	},

	// Generic handler to decode and re-post OSC messages as native events.
	_handleOsc: function(transport, message, info) {
		//if (String(message) != 'heart') console.log("osc message: " + String(message));
		var e = message[0].replace('/', '');
		var data = message[1] ? JSON.parse(message[1]) : null;
		transport.emit(e, data);
	}
});
