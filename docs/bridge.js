/*!
 * Payroll Hub bridge, protocol version 1.
 *
 * Copy this file, unchanged, into each app that should talk to the Payroll Hub dashboard.
 * It has no dependencies and does nothing at all unless the app is running inside the
 * dashboard's iframe, so the app keeps working exactly as before on its own.
 *
 * How to use it: see docs/INTEGRATION.md in the payroll-hub repository.
 *
 *   PayrollHubBridge.init({ appId: "pdf-editor", onData: function (payload) { ... } });
 *   PayrollHubBridge.sendToDashboard("send-data", { dataType: "payroll-result", rows: rows });
 */
(function (global) {
  "use strict";

  // The ONLY origin this app will accept messages from or send messages to.
  // It must equal HOSTING.dashboard in the dashboard's src/config/origins.ts.
  var HUB_ORIGIN = "https://noor1290.github.io";

  var PROTOCOL_VERSION = 1;
  var DASHBOARD_ID = "dashboard";
  var REPLY_TIMEOUT_MS = 10000;
  var REQUEST_TIMEOUT_MS = 120000; // the dashboard asks its user before answering a request
  var REMEMBERED_IDS = 200;
  var ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

  var embedded;
  try {
    embedded = global.parent !== global;
  } catch (e) {
    embedded = true;
  }

  var config = null;
  var listening = false;
  var connected = false;
  var statusListeners = [];
  var handled = {}; // message id -> acknowledgement already sent, or "pending"
  var handledOrder = [];
  var waiting = {}; // message id -> { resolve, timer } for replies we are waiting on

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    var id = "";
    while (id.length < 32) id += Math.random().toString(36).slice(2);
    return id.slice(0, 32);
  }

  function post(type, payload, id) {
    id = id || newId();
    // Always the exact dashboard origin, never "*": if anything else is embedding this app,
    // the browser drops the message instead of delivering payroll data to it.
    global.parent.postMessage(
      {
        type: type,
        from: config.appId,
        to: DASHBOARD_ID,
        version: PROTOCOL_VERSION,
        id: id,
        payload: payload || {},
      },
      HUB_ORIGIN,
    );
    return id;
  }

  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    for (var i = 0; i < statusListeners.length; i++) {
      try {
        statusListeners[i](connected);
      } catch (e) {
        /* a broken listener must not break the bridge */
      }
    }
  }

  function remember(id, ack) {
    if (!(id in handled)) {
      handledOrder.push(id);
      if (handledOrder.length > REMEMBERED_IDS) delete handled[handledOrder.shift()];
    }
    handled[id] = ack;
  }

  function failure(error) {
    var text = error && error.message ? String(error.message) : String(error || "");
    return { ok: false, error: (text || "The app could not use this data.").slice(0, 300) };
  }

  function receiveData(message) {
    var id = message.id;

    // The dashboard retries with the SAME id when an acknowledgement was late or lost.
    // Never hand the same data to the app twice: repeat the earlier answer instead.
    if (id in handled) {
      if (handled[id] !== "pending") post("received", handled[id], id);
      return;
    }
    remember(id, "pending");

    var finish = function (ack) {
      remember(id, ack);
      post("received", ack, id);
    };

    var payload = message.payload;
    if (
      !payload ||
      typeof payload.dataType !== "string" ||
      !Array.isArray(payload.rows) ||
      payload.rows.length === 0
    ) {
      return finish(failure("The data was not in the expected format."));
    }
    if (typeof config.onData !== "function") {
      return finish(failure("This app cannot receive data."));
    }

    try {
      var result = config.onData(payload);
      if (result && typeof result.then === "function") {
        result.then(
          function (value) {
            finish(value === false ? failure("The app refused the data.") : { ok: true });
          },
          function (error) {
            finish(failure(error));
          },
        );
      } else {
        finish(result === false ? failure("The app refused the data.") : { ok: true });
      }
    } catch (error) {
      finish(failure(error));
    }
  }

  function settle(id, value) {
    var entry = waiting[id];
    if (!entry) return; // a reply that arrived after we stopped waiting
    clearTimeout(entry.timer);
    delete waiting[id];
    entry.resolve(value);
  }

  function onMessage(event) {
    // Only the window that embeds us, and only from the exact dashboard origin.
    if (event.source !== global.parent) return;
    if (event.origin !== HUB_ORIGIN) return;

    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (typeof message.type !== "string") return;
    if (typeof message.id !== "string" || !ID_PATTERN.test(message.id)) return;
    if (message.from !== DASHBOARD_ID || message.to !== config.appId) return;

    if (message.version !== PROTOCOL_VERSION) {
      if (message.type === "send-data") {
        post("received", failure("This app speaks a different bridge version."), message.id);
      }
      return;
    }

    setConnected(true);

    switch (message.type) {
      case "ping":
        post("pong", {}, message.id);
        break;
      case "send-data":
        receiveData(message);
        break;
      case "received":
      case "response-data":
        settle(message.id, message.payload || failure("Empty reply from the dashboard."));
        break;
      default:
        break;
    }
  }

  var PayrollHubBridge = {
    version: PROTOCOL_VERSION,

    /** True when the app is running inside a frame (normally the dashboard). */
    isEmbedded: function () {
      return embedded;
    },

    /** True once the dashboard has been heard from. */
    isConnected: function () {
      return connected;
    },

    /**
     * Start the bridge. Safe to call when not embedded: it then does nothing and returns false.
     *
     * options.appId   this app's id in the dashboard registry ("payroll", "pdf-editor", ...)
     * options.onData  called with { dataType, rows, meta } when the dashboard sends data.
     *                 Throw, return false, or return a rejected promise to report a failure;
     *                 anything else counts as success.
     */
    init: function (options) {
      if (!options || typeof options.appId !== "string" || !options.appId) {
        throw new Error("PayrollHubBridge.init needs an appId.");
      }
      config = { appId: options.appId, onData: options.onData };
      if (!embedded) return false;
      if (!listening) {
        global.addEventListener("message", onMessage);
        listening = true;
      }
      post("ready", {});
      return true;
    },

    /**
     * Send a message to the dashboard and wait for its reply.
     *   sendToDashboard("send-data", { dataType: "payroll-result", rows: [...], meta: { period: "2026-09" } })
     * Resolves (never rejects) with { ok: true, ... } or { ok: false, error: "..." }.
     */
    sendToDashboard: function (type, payload) {
      return new Promise(function (resolve) {
        if (!embedded || !config) {
          resolve(failure("This app is not running inside the dashboard."));
          return;
        }
        if (type !== "send-data" && type !== "request-data") {
          resolve(failure('Only "send-data" and "request-data" can be sent.'));
          return;
        }
        var id = newId();
        waiting[id] = {
          resolve: resolve,
          timer: setTimeout(
            function () {
              delete waiting[id];
              resolve(failure("The dashboard did not answer in time."));
            },
            type === "request-data" ? REQUEST_TIMEOUT_MS : REPLY_TIMEOUT_MS,
          ),
        };
        post(type, payload, id);
      });
    },

    /**
     * Ask the dashboard for saved data, e.g. requestData("payroll-result", "2026-09").
     * Leave the period out for the latest run. The dashboard's user must approve the request.
     * Resolves with { ok: true, dataType, rows, meta } or { ok: false, error }.
     */
    requestData: function (dataType, period) {
      var payload = { dataType: dataType };
      if (period) payload.period = period;
      return PayrollHubBridge.sendToDashboard("request-data", payload);
    },

    /** Call `listener(connected)` now and whenever the connection state changes. Returns an unsubscribe function. */
    onStatus: function (listener) {
      statusListeners.push(listener);
      try {
        listener(connected);
      } catch (e) {
        /* ignore */
      }
      return function () {
        var index = statusListeners.indexOf(listener);
        if (index >= 0) statusListeners.splice(index, 1);
      };
    },
  };

  global.PayrollHubBridge = PayrollHubBridge;
})(typeof window !== "undefined" ? window : this);
