"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_native_dns = __toESM(require("native-dns"));
var import_net = __toESM(require("net"));
class KlafsSaunaBridge extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "klafs-sauna-bridge"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.socketServer = import_net.default.createServer();
  }
  async onReady() {
    this.setState("info.connection", false, true);
    this.setState("sauna.ready", false, true);
    this.setState("sauna.running", false, true);
    this.setState("sauna.currentTemperature", 0, true);
    this.setState("sauna.targetTemperature", 0, true);
    let realKlafsHost = "88.198.251.244";
    const question = import_native_dns.default.Question({
      name: "sauna-app.klafs.com",
      type: "ANY"
    });
    const start = Date.now();
    const req = import_native_dns.default.Request({
      question,
      server: { address: "8.8.8.8", port: 53, type: "udp" },
      timeout: 1e3
    });
    req.on("timeout", () => {
      this.log.debug("Timeout in making request");
    });
    req.on("message", (err, answer) => {
      answer.answer.forEach((a) => {
        if (a.name === "sauna-app.klafs.com" && a.type == 1) {
          this.log.debug("Settings Klafs Host to " + a.address);
          realKlafsHost = a.address;
        }
      });
    });
    req.on("end", () => {
      const delta = Date.now() - start;
      this.log.debug("Finished processing request: " + delta.toString() + "ms");
    });
    req.send();
    const SERVFAIL = import_native_dns.default.consts.NAME_TO_RCODE.SERVFAIL;
    const server = import_native_dns.default.createServer();
    server.on(
      "request",
      (outerRequest, outerResponse) => {
        this.log.debug(outerRequest.question[0].name);
        this.log.debug(JSON.stringify(outerRequest.question[0]));
        if (outerRequest.question[0].name === "sauna-app.klafs.com") {
          outerResponse.answer.push(
            import_native_dns.default.A({
              name: "sauna-app.klafs.com",
              address: this.config.hostip,
              ttl: 600
            })
          );
          outerResponse.send();
        } else {
          let requestDone2 = function() {
            outerResponse.send();
          };
          var requestDone = requestDone2;
          const innerRequest = import_native_dns.default.Request({
            question: outerRequest.question[0],
            server: {
              address: "8.8.8.8",
              type: "udp",
              port: 53
            },
            cache: false
          });
          innerRequest.send();
          outerResponse.header.rcode = SERVFAIL;
          innerRequest.on(
            "message",
            (err, innerResponse) => {
              console.log("response + ", err, innerResponse.question[0], innerResponse.header);
              outerResponse.header.rcode = innerResponse.header.rcode;
              outerResponse.answer = innerResponse.answer;
              outerResponse.additional = innerResponse.additional;
              outerResponse.authority = innerResponse.authority;
            }
          );
          innerRequest.on("end", function() {
            requestDone2();
          });
        }
      }
    );
    server.on("error", function(err) {
      console.log(err.stack);
    });
    if (this.config.option1) {
      server.serve(this.config.option2);
    }
    this.socketServer = import_net.default.createServer();
    const handleConnection = (conn) => {
      const remoteAddress = conn.remoteAddress + ":" + conn.remotePort;
      this.log.debug("new client connection from " + remoteAddress);
      const onConnData = async (d) => {
        this.log.debug("connection data from " + remoteAddress + ":" + d);
        const hex = d.toString("hex");
        if (hex.startsWith("0130f00ae200002b08ff14")) {
          const currentTempHex = hex.substr(42, 2);
          this.log.debug("currentTemp " + currentTempHex);
          const targetTempHex = hex.substr(36, 2);
          this.log.debug("targetTemp " + targetTempHex);
          const runningHex = hex.substr(32, 2);
          this.log.debug("running " + runningHex);
          const readyHex = hex.substr(34, 2);
          this.log.debug("ready " + readyHex);
          await this.setStateAsync("sauna.running", { val: runningHex == "02" ? true : false, ack: true });
          await this.setStateAsync("sauna.ready", { val: readyHex == "03" ? true : false, ack: true });
          await this.setStateAsync("sauna.currentTemperature", {
            val: parseInt(hex.substr(42, 2), 16),
            ack: true
          });
          await this.setStateAsync("sauna.targetTemperature", {
            val: parseInt(hex.substr(36, 2), 16),
            ack: true
          });
        }
        this.log.debug(hex);
        const client = new import_net.default.Socket();
        client.connect(28888, realKlafsHost, () => {
          this.log.debug("Client Connected");
          client.write(d);
        });
        client.on("data", (data) => {
          this.log.debug("Client Received: " + data);
          conn.write(data);
          client.destroy();
        });
        client.on("close", () => {
          this.log.debug("Client Connection closed");
        });
      };
      conn.on("data", onConnData);
      conn.once("close", onConnClose);
      conn.on("error", onConnError);
      function onConnClose() {
        console.log("connection from %s closed", remoteAddress);
      }
      function onConnError(err) {
        console.log("Connection %s error: %s", remoteAddress, err.message);
      }
    };
    this.socketServer.on("connection", handleConnection);
    this.socketServer.listen(28888, () => {
      this.log.info("server listening to " + JSON.stringify(this.socketServer.address()));
      this.setState("info.connection", true, true);
    });
  }
  onUnload(callback) {
    try {
      this.socketServer.close();
      this.setState("info.connection", false, true);
      callback();
    } catch (e) {
      callback();
    }
  }
  onStateChange(id, state) {
    if (state) {
      this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
    } else {
      this.log.info(`state ${id} deleted`);
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new KlafsSaunaBridge(options);
} else {
  (() => new KlafsSaunaBridge())();
}
//# sourceMappingURL=main.js.map
