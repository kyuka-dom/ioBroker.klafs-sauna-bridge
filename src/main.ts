/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from "@iobroker/adapter-core";

// Load your modules here, e.g.:
// import * as fs from "fs";

// init DNS server
import dns from "native-dns";

import net from "net";

class KlafsSaunaBridge extends utils.Adapter {
	private socketServer: net.Server;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "klafs-sauna-bridge",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
		this.socketServer = net.createServer();
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	private async onReady(): Promise<void> {
		this.setState("info.connection", false, true);
		this.setState("sauna.ready", false, true);
		this.setState("sauna.running", false, true);
		this.setState("sauna.currentTemperature", 0, true);
		this.setState("sauna.targetTemperature", 0, true);

		let realKlafsHost = "88.198.251.244";
		// Initialize your adapter here

		// get real klafs host

		const question = dns.Question({
			name: "sauna-app.klafs.com",
			type: "ANY",
		});

		const start = Date.now();

		const req = dns.Request({
			question: question,
			server: { address: "8.8.8.8", port: 53, type: "udp" },
			timeout: 1000,
		});

		req.on("timeout", () => {
			this.log.debug("Timeout in making request");
		});

		req.on("message", (err: any, answer: { answer: any[] }) => {
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

		// init DNS Server
		const SERVFAIL = dns.consts.NAME_TO_RCODE.SERVFAIL;
		const server = dns.createServer();

		server.on(
			"request",
			(
				outerRequest: {
					question: { name: any }[];
				},
				outerResponse: {
					authority: any;
					header: any;
					answer: any[];
					additional: any[];
					send: () => void;
				},
			) => {
				this.log.debug(outerRequest.question[0].name);
				this.log.debug(JSON.stringify(outerRequest.question[0]));

				if (outerRequest.question[0].name === "sauna-app.klafs.com") {
					// overwrite request
					outerResponse.answer.push(
						dns.A({
							name: "sauna-app.klafs.com",
							address: this.config.hostip,
							ttl: 600,
						}),
					);
					outerResponse.send();
				} else {
					const innerRequest = dns.Request({
						question: outerRequest.question[0],
						server: {
							address: "8.8.8.8",
							type: "udp",
							port: 53,
						},
						cache: false,
					});

					innerRequest.send();

					// in the event we get an error or timeout paper over with servfail
					outerResponse.header.rcode = SERVFAIL;

					function requestDone() {
						outerResponse.send();
					}

					innerRequest.on(
						"message",
						(
							err: any,
							innerResponse: {
								question: any[];
								header: { rcode: any };
								answer: any[];
								additional: any[];
								authority: any;
							},
						) => {
							console.log("response + ", err, innerResponse.question[0], innerResponse.header);
							outerResponse.header.rcode = innerResponse.header.rcode;

							outerResponse.answer = innerResponse.answer;
							outerResponse.additional = innerResponse.additional;
							outerResponse.authority = innerResponse.authority;
						},
					);

					innerRequest.on("end", function () {
						requestDone();
					});
				}
				//console.log(request)
			},
		);

		server.on("error", function (err: { stack: any }) {
			console.log(err.stack);
		});

		if (this.config.option1) {
			server.serve(this.config.option2);
		}

		// INIT socket
		this.socketServer = net.createServer();

		const handleConnection = (conn: any) => {
			const remoteAddress = conn.remoteAddress + ":" + conn.remotePort;
			this.log.debug("new client connection from " + remoteAddress);
			const onConnData = async (d: any) => {
				this.log.debug("connection data from " + remoteAddress + ":" + d);
				const hex = d.toString("hex");
				if (hex.startsWith("0130f00ae200002b08ff14")) {
					// status Message -> update the variables
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
						ack: true,
					});
					await this.setStateAsync("sauna.targetTemperature", {
						val: parseInt(hex.substr(36, 2), 16),
						ack: true,
					});
				}
				this.log.debug(hex);

				const client: net.Socket = new net.Socket();
				client.connect(28888, realKlafsHost, () => {
					this.log.debug("Client Connected");
					client.write(d);
				});

				client.on("data", (data) => {
					this.log.debug("Client Received: " + data);
					conn.write(data);
					client.destroy(); // kill client after server's response
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
			function onConnError(err: any) {
				console.log("Connection %s error: %s", remoteAddress, err.message);
			}
		};

		this.socketServer.on("connection", handleConnection);
		this.socketServer.listen(28888, () => {
			this.log.info("server listening to " + JSON.stringify(this.socketServer.address()));
			this.setState("info.connection", true, true);
		});

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		/*this.log.info("config option1: " + this.config.option1);
		this.log.info("config option2: " + this.config.option2);*/

		/*
		For every state in the system there has to be also an object of type state
		Here a simple template for a boolean variable named "testVariable"
		Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		*/
		/*await this.setObjectNotExistsAsync("testVariable", {
			type: "state",
			common: {
				name: "testVariable",
				type: "boolean",
				role: "indicator",
				read: true,
				write: true,
			},
			native: {},
		});*/

		// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		/*this.subscribeStates("testVariable");*/
		// You can also add a subscription for multiple states. The following line watches all states starting with "lights."
		// this.subscribeStates("lights.*");
		// Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
		// this.subscribeStates("*");

		/*
			setState examples
			you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		*/
		// the variable testVariable is set to true as command (ack=false)
		/*await this.setStateAsync("testVariable", true);

		// same thing, but the value is flagged "ack"
		// ack should be always set to true if the value is received from or acknowledged from the target system
		await this.setStateAsync("testVariable", { val: true, ack: true });

		// same thing, but the state is deleted after 30s (getState will return null afterwards)
		await this.setStateAsync("testVariable", { val: true, ack: true, expire: 30 });

		// examples for the checkPassword/checkGroup functions
		let result = await this.checkPasswordAsync("admin", "iobroker");
		this.log.info("check user admin pw iobroker: " + result);

		result = await this.checkGroupAsync("admin", "admin");
		this.log.info("check group user admin group admin: " + result);*/
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 */
	private onUnload(callback: () => void): void {
		try {
			this.socketServer.close();
			this.setState("info.connection", false, true);
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  */
	// private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  */
	// private onMessage(obj: ioBroker.Message): void {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new KlafsSaunaBridge(options);
} else {
	// otherwise start the instance directly
	(() => new KlafsSaunaBridge())();
}
