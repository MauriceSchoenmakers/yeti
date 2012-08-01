"use strict";

var util = require("util");
var EventEmitter2 = require("eventemitter2").EventEmitter2;
var EventYoshi = require("eventyoshi");

var parseUA = require("./ua");

// TODO: Periodic GC of missing Agents.
// var periodic = require("./periodic");

/**
 * An AgentGroup is a collection of Agents
 * that share the load of testing a Batch.
 *
 * @class AgentGroup
 * @constructor
 */
function AgentGroup() {
    this.ua = ua;
    this.agents = agents;
}

/**
 * An Agent represents a web browser.
 *
 * @class Agent
 * @constructor
 * @inherits EventEmitter2
 * @param {AgentManager} manager AgentManager associated with this Agent.
 * @param {Object} registration Object with `id` and `ua` properties.
 */
function Agent(manager, registration) {
    this.manager = manager;

    this.id = registration.id;
    this.ua = registration.ua;

    var abortNow;

    this.ttl = registration.ttl || Agent.TTL;

    if (!this.id) {
        throw new Error("ID required.");
    } else if (!this.ua) {
        // TODO Zombies should be killed.
        // If the Yeti Client goes away, the zombies should
        // move back to the capture page.
        abortNow = "Unknown (zombie browser from previous test run)";
        this.ua = abortNow;
    }

    this.name = parseUA(this.ua);

    this.seen = new Date();
    this.waiting = true;
    this.connected = true;

    this.urlQueue = [];
    this.currentUrl = null;

    EventEmitter2.call(this);

    // The this.socketEmitter EventYoshi should
    // contain at most 1 Socket.io socket.
    //
    // We use an EventYoshi so that event
    // listeners for sockets only need to be
    // setup once. We can then connect and
    // disconnect the Agent's socket as needed.
    this.socketEmitter = new EventYoshi();
    this.socketEmitterQueue = [];

    this.setupEvents();
    this.connect(registration.socket);
    
    if (abortNow) {
        this.abort();
        this.emit("agentError", abortNow);
    }
}

util.inherits(Agent, EventEmitter2);

/**
 * TTL for Agents in seconds.
 *
 * Agents are discared if they do not respond
 * for this many seconds.
 *
 * @property TTL
 * @type Number
 * @default 3600
 */
Agent.TTL = 3600;

/**
 * The Agent emitted a heartbeat.
 *
 * @event beat
 */

/**
 * The Agent reported test results.
 *
 * @event results
 * @param {Object} YUI Test results object.
 */

/**
 * The Agent reported a JavaScript error.
 *
 * @event scriptError
 * @param {Object} Error-like object.
 */

/**
 * The Agent became unable to run tests.
 *
 * @event agentError
 * @param {Object} Error-like object.
 */

/**
 * The Agent disconnected. This event is normal during
 * test runs as the Agent navigates to a new test.
 *
 * @event agentDisconnect
 */

/**
 * The Agent was seen, e.g. by connecting.
 *
 * @event agentSeen
 * @param {String} name Agent name.
 */

/**
 * The current queue of test URLs was aborted.
 *
 * @event abort
 */

/**
 * Setup events on `this.socketEmitter`.
 *
 * @method setupEvents
 * @private
 */
Agent.prototype.setupEvents = function () {
    var self = this;

    self.socketEmitter.on("close", function () {
        self.socketEmitter.remove(this.child);
    });

    self.socketEmitter.on("results", function (data) {
        self.emit("results", data);
        self.next();
    });

    self.socketEmitter.on("scriptError", function (details) {
        self.emit("scriptError", details);
        self.next();
    });

    self.socketEmitter.on("heartbeat", function () {
        self.ping();
    });

    self.socketEmitter.on("beat", function () {
        self.ping();
        self.emit("beat");
    });
};

/**
 * Get this agent's human-readable name.
 *
 * @method getName
 * @return {String} Agent name.
 */
Agent.prototype.getName = function () {
    return this.name;
};

/**
 * Get this agent's ID.
 *
 * @method getId
 * @return {String} Numeric agent ID.
 */
Agent.prototype.getId = function () {
    return this.id;
};

/**
 * Provide a socket for communication with
 * the Agent.
 *
 * @method connect
 * @param {SimpleEvents} socket Instance of SimpleEvents
 * for this socket connection, itself an EventEmitter2 instance.
 */
Agent.prototype.connect = function (socket) {
    var self = this,
        queuedEvents = self.socketEmitterQueue.slice();

    self.socketEmitter.add(socket);

    if (queuedEvents.length) {
        if (process.env.TRAVIS) console.log("emitting queued events", self.socketEmitterQueue);
        self.socketEmitterQueue = [];
        queuedEvents.forEach(function (args) {
            self.socketEmitter.emit.apply(self.socketEmitter, args);
        });
    }
};

/**
 * Get the value for the next URL,
 * removing it from `this.urlQueue`.
 *
 * Fires our complete event when no more
 * URLs are in the queue, then returns
 * the capture page URL.
 *
 * @method nextURL
 * @return {String} Next test URL, or capture page URL.
 */
Agent.prototype.nextURL = function () {
    var url;

    if (this.urlQueue.length) {
        url = this.urlQueue.shift();
        this.waiting = false;
    } else {
        url = this.manager.hub.mountpoint;
        if (url !== "/") {
            // XXX So hacky.
            url += "/";
        }

        url += "agent/" + this.id;
        this.waiting = true;
        this.emit("complete");
    }
    this.currentUrl = url;

    return url;
};

/**
 * Queue an event to emit on the socketEmitter
 * once a socket is added to the socketEmitter
 * EventYoshi. If a socket is ready, emit
 * the event immediately.
 *
 * @method queueSocketEmit
 * @protected
 * @param {String} event Event name.
 * @param {Object} data Event payload.
 */
Agent.prototype.queueSocketEmit = function (event, data) {
    // Is anybody listening on the socketEmitter?
    if (this.socketEmitter.children.length > 0) {
        if (process.env.TRAVIS) console.log("queueSocketEmit real", event, data);
        this.socketEmitter.emit(event, data);
    } else {
        if (process.env.TRAVIS) console.log("queueSocketEmit queued", event, data);
        this.socketEmitterQueue.push([event, data]);
    }
};

/**
 * Queue an event to navigate the Agent
 * to the next URL.
 *
 * @method next
 * @return {Boolean} True if the browser is waiting, false otherwise
 */
Agent.prototype.next = function () {
    this.queueSocketEmit("navigate", this.nextURL());
    return !this.waiting;
};

/**
 * Is this browser running tests?
 *
 * @method available
 * @return {Boolean} True if the browser idle, false if it is running tests.
 */
Agent.prototype.available = function () {
    return this.waiting;
};

/**
 * Set the URL queue to the given URL array
 * and advance the browser to the first test.
 *
 * @method dispatch
 * @param {Array} urls URLs to test.
 */
Agent.prototype.dispatch = function (urls) {
    if (!this.alive()) {
        return this.unload();
    }

    this.urlQueue = urls;

    this.next();
};

/**
 * TODO
 *
 * @method unload
 */
Agent.prototype.unload = function () {
    this.connected = false;
    this.seen = 0;
    this.waiting = false;
    this.emit("disconnect");
};

/**
 * Abort running the current test
 * and advance to the next test.
 *
 * @method abort
 */
Agent.prototype.abort = function () {
    this.emit("abort");
    this.emit("agentError", {
        message: "Agent timed out running test: " + this.currentUrl
    });
    this.next(); //to next test
};

/**
 * Record that this browser is
 * still active.
 *
 * @method ping
 */
Agent.prototype.ping = function () {
    this.connected = true;
    this.seen = new Date();
    this.emit("beat");
};

/**
 * Check if this Agent is expired,
 * meaning that it has not connected
 * in a since the TTL.
 *
 * @method expired
 * @return {Boolean} True if the Agent is expired, false otherwise.
 */
Agent.prototype.expired = function () {
    return (!this.waiting && ((Date.now() - this.seen) > this.ttl));
};

/**
 * TODO
 *
 * @method alive
 * @return TODO
 */
Agent.prototype.alive = function () {
    return this.connected || !this.expired();
};

/**
 * @class AgentManager
 * @constructor
 * @inherits EventEmitter2
 * @param {Hub} hub Yeti Hub associated with this AgentManager.
 * @param {Number} ttl TTL for associated Agents.
 */
function AgentManager(hub, ttl) {
    this.hub = hub;
    this.agents = {};
    EventEmitter2.call(this, {
        verbose: true
    });

    this.ttl = ttl || AgentManager.REAP_TTL;

    this._startReap();
}

util.inherits(AgentManager, EventEmitter2);

/**
 * @property REAP_TTL
 * @type Number
 * @default 45000
 */
//TODO Make this configurable
//TODO This should probably be allowed to be passed to an Agent as it's TTL too. Not sure
AgentManager.REAP_TTL = (45 * 1000); //Default reap timeout


/**
 * TODO
 *
 * @method _startReap
 * @private
 */
//TODO this needs to be destroyed at some point, just not sure where (`agentManager.destroy()` maybe)
AgentManager.prototype._startReap = function () {
    this._reap = setInterval(this.reap.bind(this), this.ttl);
};

/**
 * TODO
 *
 * @method reap
 * @private
 */
AgentManager.prototype.reap = function () {
    this.getAgents().forEach(function (agent) {
        if (agent.expired()) {
            agent.abort();
        }
    });
};

/**
 * Get all Agents marked as available.
 *
 * @method getAvailableAgents
 * @return {Array} Agents marked available.
 */
AgentManager.prototype.getAvailableAgents = function () {
    return this.getAgents().filter(function (agent) {
        return agent.available();
    });
};

/**
 * Get all Agents.
 *
 * @method getAgents
 * @return {Array} Agents.
 */
AgentManager.prototype.getAgents = function () {
    var out = [],
        self = this;
    Object.keys(self.agents).forEach(function (id) {
        out.push(self.agents[id]);
    });
    return out;
};

/**
 * Get an Agent by ID.
 *
 * @method getAgent
 * @param {Number} id Agent ID.
 * @return {Agent} The matching agent.
 */
AgentManager.prototype.getAgent = function (id) {
    return this.agents[id];
};

/**
 * Connect the given socket and UA string
 * to the Agent instance identified by the
 * given ID.
 *
 * @method connectAgent
 * @param {Number} id Agent ID.
 * @param {String} ua User-Agent.
 * @param {SimpleEvents} socket Socket.
 */
AgentManager.prototype.connectAgent = function (id, ua, socket) {
    var self = this,
        firstConnect = false,
        agent = self.agents[id];

    if (!id) {
        throw new Error("ID required.");
    } else if (!socket) {
        throw new Error("Socket required.");
    }

    if (agent) {
        agent.connect(socket);
    } else {
        firstConnect = true;
        agent = self.agents[id] = new Agent(self, {
            id: id,
            ua: ua,
            socket: socket
        });
    }

    if (firstConnect) {
        // XXX Serialize the agent to JSON.
        self.emit("agentConnect", agent.getName());
        agent.once("disconnect", function () {
            delete self.agents[agent.id];
            self.emit("agentDisconnect", agent.getName());
        });
    }

    self.emit("agentSeen", agent.getName());
};

exports.Agent = Agent;
exports.AgentManager = AgentManager;
